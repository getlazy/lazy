/**
 * E2E: the Current-review "Before you can accept" link for an undecided
 * protected file lands on that file's Changes card, and a file split into
 * several presentation snippets still has ONE approve/reject — on the file
 * header, not on each hunk card.
 *
 * THE BUG (web-file-decisions-per-file): reviewing a conflict task whose
 * protected test file was presented as four far-apart hunks, the checklist
 * link went to /changes with no hash, and each hunk card carried its own
 * Approve/Reject even though file_decisions is one record per path.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS, disablePreAccept, setProtectedPatterns } from '../helpers/fixtures';
import { worktreePathFor } from '../helpers/storage';
import { runMcpSession } from '../helpers/mcp-session';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { fileSectionId } from '../../src/server/review-diff';

const SPEC = 'a.spec.ts';
const LINES = 80;
const CHANGED = [5, 25, 45, 65] as const;

function specContents(tweak: ReadonlySet<number>): string {
  const lines: string[] = [];
  for (let i = 1; i <= LINES; i++) {
    lines.push(
      tweak.has(i)
        ? `test('changed ${i}', () => {});`
        : `test('line ${i}', () => {});`,
    );
  }
  return `${lines.join('\n')}\n`;
}

describe('protected-file decisions are per file, not per hunk', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: {
        LAZY_MOCK_SHOULD_COMMIT: '1',
        LAZY_MOCK_FILES: JSON.stringify([
          { path: SPEC, content: specContents(new Set(CHANGED)) },
        ]),
      },
    });
    disablePreAccept(ctx.root);
    setProtectedPatterns(ctx.root, ['*.spec.*']);
    writeFileSync(join(ctx.root, SPEC), specContents(new Set()));
    ctx.git('add', 'lazy.toml', SPEC);
    ctx.git('commit', '-m', 'Protect specs and seed a long spec file');

    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function conflictTask(goal: string): Promise<string> {
    const shortId = await createTask(ctx, goal, 'Touch the spec in several places');
    expectSuccess(await ctx.lazyMocked(['start', shortId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    expect((await ctx.lazy(['wait', shortId])).exitCode).toBe(0);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = (queue as { id: string }[]).find((e) => e.id.startsWith(shortId));
      if (hit) return hit.id;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`task ${shortId} never reached the review queue`);
  }

  async function page(path: string): Promise<string> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}${path}`);
      if (res.status === 200) {
        const html = await res.text();
        if (html.includes('data-lz-task-page') || html.includes('id="rv-root"')) return html;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`GET ${path} never became ready`);
  }

  test('checklist hash lands on the file; consecutive snippets approve once from the header', async () => {
    const id = await conflictTask('Per-file protected decision');
    const worktree = worktreePathFor(ctx.root, id);

    const snippets = CHANGED.map((line) => ({
      kind: 'snippet' as const,
      file: SPEC,
      start: line - 2,
      end: line + 2,
      note: `hunk at ${line}`,
    }));

    const replies = await runMcpSession(ctx.root, id, worktree, [
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
            sections: [{ kind: 'what_was_done', body: 'Touched the spec in four places' }],
            presentation: {
              groups: [{ title: 'Spec edits', tier: 'core', items: snippets }],
            },
          },
        },
      },
    ]);
    const report = replies.find((r) => r.id === 2);
    expect(report?.result?.isError ?? false).toBe(false);

    const fileHash = fileSectionId(SPEC);
    const review = await page(`/tasks/${id}/review`);
    expect(review).toContain('Before you can accept');
    // The path is wrapped in <code>, so the contiguous "file has no decision"
    // string the reviewer reads is split in the markup.
    expect(review).toContain(`<code>${SPEC}</code> has no decision`);
    // The remedy is the file's Changes anchor, not the bare tab.
    expect(review).toContain(`href="/tasks/${id}/changes#${fileHash}"`);

    const changes = await page(`/tasks/${id}/changes`);
    const presented = changes.split('id="rv-presented"')[1]?.split('id="rv-root"')[0] ?? '';
    expect(presented.length).toBeGreaterThan(0);
    // INVARIANT: consecutive hunks of one protected file are one card with
    // one approve/reject on the header — not one control per snippet.
    expect((presented.match(new RegExp(`data-rv-decide="${SPEC}"`, 'g')) ?? []).length).toBe(1);
    expect((presented.match(new RegExp(`data-viewed-key="${SPEC}"`, 'g')) ?? []).length).toBe(1);
    expect(presented).toContain(`id="${fileHash}"`);
    expect(presented).toContain('action="/tasks/' + id + '/review/violation"');
    expect(presented).toContain(`<input type="hidden" name="file" value="${SPEC}">`);

    const res = await fetch(`${base}/tasks/${id}/review/violation`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ file: SPEC, approved: '1' }).toString(),
    });
    expect(res.ok).toBe(true);

    const after = await page(`/tasks/${id}/changes`);
    const afterPresented = after.split('id="rv-presented"')[1]?.split('id="rv-root"')[0] ?? '';
    expect((afterPresented.match(new RegExp(`data-rv-decide="${SPEC}"`, 'g')) ?? []).length).toBe(1);
    const control = (afterPresented.split(`data-rv-decide="${SPEC}"`)[1] ?? '').split('</form>')[0];
    expect(control).toMatch(/value="1"[^>]*rv-decide-on/);
    expect(control).toContain('protected — change accepted');
  }, 120_000);
});
