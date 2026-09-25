/**
 * Slice 4 of the tabbed task page: behaviour-first report split, Raised
 * dialog, and symbol/task-code autolinks through one markdown linkify pass.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, extractTaskId } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { findFullTaskId, taskFilePath, worktreePathFor } from '../helpers/storage';
import { runMcpSession } from '../helpers/mcp-session';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { anchorDomId } from '../../src/server/review-diff';

describe('tabbed task page prose', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function blockedTask(goal: string): Promise<string> {
    const shortId = await createTask(ctx, goal, 'Do work');
    await ctx.lazyMocked(['start', shortId, '--yes'], MOCK_CLAUDE_SUCCESS);
    const waited = await ctx.lazy(['wait', shortId]);
    if (waited.exitCode !== 0) {
      throw new Error(`wait failed for ${shortId}: ${waited.stderr}\n${waited.stdout}`);
    }
    return shortId;
  }

  async function submitReport(taskId: string, sections: Array<{ kind: string; body: string }>): Promise<void> {
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
        params: { name: 'lazy_report', arguments: { sections } },
      },
    ], { timeoutMs: 60_000 });
    expect(responses.find((r) => r.id === 2)?.result?.isError).toBeFalsy();
  }

  test('behavior_change lands on Landing above capabilities_lost; implementation on Changes', async () => {
    const taskId = await blockedTask('Behavior first split');
    await submitReport(taskId, [
      { kind: 'implementation', body: 'moved soAndSo to a new module' },
      { kind: 'behavior_change', body: 'the report now splits across tabs' },
      { kind: 'capabilities_lost', body: 'nothing lost' },
    ]);

    const landing = await (await fetch(`${base}/tasks/${taskId}`)).text();
    expect(landing).toContain('data-kind="behavior_change"');
    expect(landing).toContain('data-kind="capabilities_lost"');
    expect(landing).not.toContain('data-kind="implementation"');
    expect(landing).toContain('the report now splits across tabs');
    expect(landing.indexOf('data-kind="behavior_change"')).toBeLessThan(
      landing.indexOf('data-kind="capabilities_lost"'),
    );
    expect(landing).toContain('implementation lives on Changes');

    const changes = await (await fetch(`${base}/tasks/${taskId}/changes`)).text();
    expect(changes).toContain('data-kind="implementation"');
    expect(changes).toContain('moved soAndSo to a new module');
    expect(changes).not.toContain('data-kind="behavior_change"');

    const shown = await ctx.lazy(['show', taskId]);
    expectSuccess(shown);
    expectOutput(shown, 'What changed for you');
    expectOutput(shown, 'How it was done');
    expect(shown.stdout.indexOf('What changed for you')).toBeLessThan(
      shown.stdout.indexOf('How it was done'),
    );
  }, 90_000);

  test('legacy what_was_done stays on Landing as What was done, not the no-behavior notice', async () => {
    const taskId = await blockedTask('Legacy report kind');
    await submitReport(taskId, [
      { kind: 'what_was_done', body: 'Shipped the report tool' },
    ]);

    const landing = await (await fetch(`${base}/tasks/${taskId}`)).text();
    expect(landing).toContain('data-kind="what_was_done"');
    expect(landing).toContain('Shipped the report tool');
    expect(landing).toContain('What was done');
    expect(landing).not.toContain('Agent declared no behavioral change.');
    expect(landing).not.toContain('implementation lives on Changes');

    const changes = await (await fetch(`${base}/tasks/${taskId}/changes`)).text();
    expect(changes).not.toContain('data-kind="what_was_done"');
  }, 90_000);

  test('opening /raised/:id renders the Raised tab with the dialog and autolinks task codes', async () => {
    const target = await ctx.lazy([
      'create', '--goal', 'Wiring target', '--code', 'fix-docs-release-wiring',
    ]);
    expectSuccess(target);
    const targetId = extractTaskId(target.stdout);

    const taskId = await createTask(ctx, 'Raised dialog', 'Do work');
    const fullId = findFullTaskId(ctx.root, taskId);
    const itemId = randomUUID();
    const content =
      'H. MOVE candidates, per row of plan §5.2, onto fix-docs-release-wiring';
    writeFileSync(
      taskFilePath(ctx.root, taskId, 'raised-items.json'),
      JSON.stringify({
        raised_items: [{
          id: itemId,
          task_id: fullId,
          content,
          blocking: false,
          status: 'open',
          created_at: Date.now(),
        }],
      }, null, 2),
    );

    const list = await (await fetch(`${base}/tasks/${taskId}/raised`)).text();
    expect(list).toContain(`/raised/${itemId}`);
    // Title is the sentence, not the enumerator `H.`
    expect(list).toContain('H. MOVE candidates');
    expect(list).not.toMatch(/>H\.</);

    const page = await fetch(`${base}/raised/${itemId}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('data-lz-current-tab="raised"');
    expect(html).toContain('lz-raised-dialog');
    expect(html).toContain('name="raised_action');
    expect(html).toContain(`href="/tasks/${findFullTaskId(ctx.root, targetId)}"`);
    expect(html).toContain('lz-task-link');

    const fragment = await fetch(`${base}/raised/${itemId}?fragment=1`);
    expect(fragment.status).toBe(200);
    const panel = await fragment.text();
    expect(panel).toContain('lz-raised-panel');
    expect(panel).not.toContain('data-lz-tab-strip');
    expect(panel).toContain('lz-task-link');
  }, 90_000);

  test('a report referencing a changed function links to that diff row', async () => {
    const shortId = await blockedTask('Symbol jump');
    const taskId = findFullTaskId(ctx.root, shortId);
    const worktree = worktreePathFor(ctx.root, shortId);
    writeFileSync(join(worktree, 'src-jump.ts'), 'export function soAndSo() {\n  return 1;\n}\n');
    expect(ctx.git('-C', worktree, 'add', 'src-jump.ts').exitCode).toBe(0);
    expect(ctx.git('-C', worktree, 'commit', '-m', 'Add soAndSo').exitCode).toBe(0);

    await submitReport(shortId, [
      { kind: 'implementation', body: 'Changed `soAndSo()` this turn.' },
    ]);

    const anchor = anchorDomId({ file: 'src-jump.ts', side: 'new', line: 1 });
    const href = `/tasks/${taskId}/changes#${anchor}`;

    const landing = await (await fetch(`${base}/tasks/${taskId}`)).text();
    // No behavior section — the notice is on Landing; the jump lives on Changes.
    expect(landing).toContain('Agent declared no behavioral change.');

    const changes = await (await fetch(`${base}/tasks/${taskId}/changes`)).text();
    expect(changes).toContain(`href="${href}"`);
    expect(changes).toContain(`id="${anchor}"`);
    expect(changes).toContain('<code>soAndSo()</code>');
  }, 90_000);
});
