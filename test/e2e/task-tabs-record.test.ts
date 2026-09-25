/**
 * Slice 2 of the tabbed task page: Turns folding, Subtasks grouping at 300
 * children with no cap, and Services branch-port advice.
 *
 * The 300-child hub is seeded as task.json files under external storage —
 * 300× `lazy create` would dominate the suite. FileStorage reconciles new
 * directories on the next read, so no daemon restart is required.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { findFullTaskId, tasksDirFor, worktreePathFor } from '../helpers/storage';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import type { TaskStatus } from '../../src/types';

describe('tabbed task page record (slice 2)', () => {
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

  async function blockedTask(goal: string): Promise<{ shortId: string; id: string }> {
    const shortId = await createTask(ctx, goal, 'Do work');
    expectSuccess(await ctx.lazyMocked(['start', shortId, '--yes'], MOCK_CLAUDE_SUCCESS));
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = (queue as { id: string }[]).find((e) => e.id.startsWith(shortId));
      if (hit) return { shortId, id: hit.id };
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`task ${shortId} never reached the review queue`);
  }

  test('a 300-child hub renders grouped with the right counts and no truncation', async () => {
    const hubShort = await createTask(ctx, 'Three hundred children hub');
    const hubId = findFullTaskId(ctx.root, hubShort);
    const grandchildParentId = seedThreeHundredChildren(ctx.root, hubId);

    const res = await fetch(`${base}/tasks/${hubId}/subtasks`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('Subtasks (300)');
    expect(html).toContain('Needs you (8)');
    expect(html).toContain('Active (6)');
    expect(html).toContain('Backlog (20)');
    expect(html).toContain('Done (250)');
    expect(html).toContain('Closed (16)');
    expect((html.match(/<tr data-lz-subtasks-row/g) ?? []).length).toBe(300);
    expect(html).not.toContain('truncated');
    expect(html).not.toContain('Load more');
    expect(html).toContain('data-lz-subtasks-filter');
    expect(html).toContain(`href="/tasks/${grandchildParentId}/subtasks"`);
    expect(html).toContain('>1</a>');
    // INVARIANT: each group lists its most recently updated child first, and a
    // jump bar links every non-empty group. Child 34 is the newest Done child,
    // child 283 the oldest.
    expect(html.indexOf('Seeded child 34<')).toBeLessThan(html.indexOf('Seeded child 283<'));
    for (const g of ['needs-you', 'active', 'backlog', 'done', 'closed']) {
      expect(html).toContain(`href="#subtasks-${g}" data-lz-subtasks-jump`);
    }

    const landing = await (await fetch(`${base}/tasks/${hubId}`)).text();
    expect(landing).toContain('300 subtasks');
    expect(landing).toContain('/subtasks#subtasks-needs-you');
    expect(landing).toContain('8 need you');
  }, 60_000);

  test("a journal entry's anchor resolves from the activity card", async () => {
    const { id } = await blockedTask('Journal anchor probe');
    expectSuccess(await ctx.lazy(['journal', id, '--message', 'Chose the fold window by timestamp']));

    const landing = await (await fetch(`${base}/tasks/${id}`)).text();
    const match = landing.match(/href="\/tasks\/[^"]+\/turns#journal-([^"]+)"/);
    expect(match).not.toBeNull();
    const journalId = match![1];

    const turns = await fetch(`${base}/tasks/${id}/turns`);
    expect(turns.status).toBe(200);
    const html = await turns.text();
    expect(html).toContain(`id="journal-${journalId}"`);
    expect(html).toContain('Chose the fold window by timestamp');
    expect(html).not.toContain('<h2>Journal');
  }, 60_000);

  test('commits appear under the turn that produced them and on the Commits tab', async () => {
    const { id } = await blockedTask('Per-turn commits probe');

    // Wait until the mock agent's content commit is reconciled onto the Turns tab.
    let turnsHtml = '';
    let commitHref = '';
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/tasks/${id}/turns`);
      expect(res.status).toBe(200);
      turnsHtml = await res.text();
      const match = turnsHtml.match(/href="(\/tasks\/[^"]+\/commits\/[^"]+)"/);
      if (match && turnsHtml.includes('turn-commits')) {
        commitHref = match[1]!;
        break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    expect(turnsHtml).toContain('turn-commits');
    expect(commitHref).toMatch(/\/tasks\/[^/]+\/commits\//);
    // Nested under an agent turn card, not a bare chunk sibling heading.
    expect(turnsHtml).toContain('>Turn #');
    const agentTurnAt = turnsHtml.indexOf('[agent]');
    const nestedAt = turnsHtml.indexOf('turn-commits');
    expect(agentTurnAt).toBeGreaterThan(-1);
    expect(nestedAt).toBeGreaterThan(agentTurnAt);

    const commitsRes = await fetch(`${base}/tasks/${id}/commits`);
    expect(commitsRes.status).toBe(200);
    const commitsHtml = await commitsRes.text();
    expect(commitsHtml).toContain('data-lz-tab="commits"');
    expect(commitsHtml).toContain('aria-current="page"');
    expect(commitsHtml).toContain('<h2>Commits (');
    expect(commitsHtml).toContain(commitHref);
    // Badge on the strip.
    expect(commitsHtml).toMatch(/data-lz-tab="commits"[^>]*>Commits <span class="lz-tab-badge">/);
  }, 90_000);

  test('a branch port the root lacks is advised on Services', async () => {
    const { shortId, id } = await blockedTask('Branch port advice');
    const worktree = worktreePathFor(ctx.root, shortId);
    expect(existsSync(worktree)).toBe(true);
    const tomlPath = join(worktree, 'lazy.toml');
    const before = existsSync(tomlPath) ? readFileSync(tomlPath, 'utf-8') : '';
    writeFileSync(tomlPath, `${before}\n[serve]\nports = [39991]\n`);

    const res = await fetch(`${base}/tasks/${id}/services`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Ports on this branch only');
    expect(html).toContain(`lazy forward ${shortId} 39991`);
    expect(html).toContain('39991');
  }, 60_000);
});

/**
 * 5 blocked + 3 conflict, 4 working + 2 pairing, 20 backlog, 250 complete,
 * 16 abandoned = 300 direct children. One complete child gets a grandchild
 * so the nested column can show 1.
 */
function seedThreeHundredChildren(root: string, parentId: string): string {
  const statuses: TaskStatus[] = [
    ...Array<TaskStatus>(5).fill('blocked'),
    ...Array<TaskStatus>(3).fill('conflict'),
    ...Array<TaskStatus>(4).fill('working'),
    ...Array<TaskStatus>(2).fill('pairing'),
    ...Array<TaskStatus>(20).fill('backlog'),
    ...Array<TaskStatus>(250).fill('complete'),
    ...Array<TaskStatus>(16).fill('abandoned'),
  ];
  expect(statuses.length).toBe(300);

  const tasksDir = tasksDirFor(root);
  let grandchildParentId = '';
  const firstComplete = statuses.indexOf('complete');

  for (let i = 0; i < statuses.length; i++) {
    const id = `c0000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    if (i === firstComplete) grandchildParentId = id;
    writeSeededTask(tasksDir, id, parentId, statuses[i]!, `Seeded child ${i}`, i);
  }

  writeSeededTask(
    tasksDir,
    'c0000000-0000-4000-8000-000000000301',
    grandchildParentId,
    'backlog',
    'Grandchild of a done child',
  );
  return grandchildParentId;
}

function writeSeededTask(
  tasksDir: string,
  id: string,
  parentId: string,
  status: TaskStatus,
  goal: string,
  // Seconds before now this child finished — a spread, so ordering is testable.
  ageSeconds = 0,
): void {
  const dir = join(tasksDir, id);
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  writeFileSync(join(dir, 'task.json'), JSON.stringify({
    id,
    code: null,
    goal,
    prompt: '',
    type: 'task',
    status,
    created_at: now,
    completed_at: status === 'complete' || status === 'abandoned' ? now - ageSeconds * 1000 : null,
    target: { kind: 'task', parentTaskId: parentId },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    runner_type: null,
    metadata: null,
    tags: [],
    pending_sync: 0,
  }, null, 2));
}
