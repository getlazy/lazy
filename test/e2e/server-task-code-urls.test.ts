/**
 * Task URLs carry the task's CODE — `/tasks/teams-cli-login`, not the UUID.
 *
 * Every `/tasks/:id` route already resolves a code, a hex prefix, or an id
 * (Storage.getTask → findTaskIdByPrefix), so this change is link-generation
 * only: new links name the task the way a human does. Three behaviors are
 * load-bearing and asserted here:
 *   1. a coded task's links and redirects carry its code;
 *   2. a codeless task's links carry its id (never an empty or broken href);
 *   3. the UUID URL keeps working — bookmarks and history never break.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { readTaskJson, writeTaskJson } from '../helpers/storage';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';

describe('task URLs by code', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('the create form redirects to the new task by code', async () => {
    const res = await fetch(`${base}/tasks/new`, {
      method: 'POST',
      body: new URLSearchParams({
        goal: 'Coded task',
        prompt: 'x',
        code: 'coded-url-task',
        type: 'task',
        agent: '',
        model: '',
        effort: '',
        parent: '',
      }),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    // The address bar carries the name the engineer knows the task by.
    expect(res.headers.get('location')).toContain('/tasks/coded-url-task');
  }, 60_000);

  test('a coded task page is served by its code URL and links by code', async () => {
    const taskId = await createTask(ctx, 'Coded link task', 'Do the thing');
    const coded = await ctx.lazy(['edit', taskId, '--code', 'coded-link-task']);
    expect(coded.exitCode).toBe(0);

    // The code URL resolves to the task the id does.
    const byCode = await (await fetch(`${base}/tasks/coded-link-task`)).text();
    expect(byCode).toContain('Coded link task');
    // The page's own tab strip and shell controls carry the code segment.
    expect(byCode).toContain('/tasks/coded-link-task/review');
    expect(byCode).toContain('/tasks/coded-link-task/turns');
    // The UUID no longer appears as an href target on the page (it may appear
    // as an identity attribute or in scripts).
    expect(byCode).not.toContain(`href="/tasks/${taskId}"`);
    expect(byCode).not.toContain(`href="/tasks/${taskId}/`);
  }, 60_000);

  test('INVARIANT: a task UUID URL still resolves — bookmarks never break', async () => {
    // INVARIANT: new links carry codes, but every `/tasks/:id` route must keep
    // resolving the raw UUID exactly as before, or every bookmark, history
    // entry and old prompt link breaks the moment this lands.
    const taskId = await createTask(ctx, 'Uuid bookmark task', 'x');
    const page = await (await fetch(`${base}/tasks/${taskId}`)).text();
    expect(page).toContain('Uuid bookmark task');
    expect(page).toContain('/actions/start');
  }, 60_000);

  test('a codeless task links by id — never a broken href', async () => {
    const taskId = await createTask(ctx, 'Codeless task', 'x');
    const fullId = (readTaskJson(ctx.root, taskId) as { id: string }).id;
    const page = await (await fetch(`${base}/tasks/${taskId}`)).text();
    expect(page).toContain('Codeless task');
    // The task's own links fall back to its full id (createTask returns the
    // short id the CLI prints; the href carries the full UUID).
    expect(page).toContain(`/tasks/${fullId}/review`);
    expect(page).toContain(`/tasks/${fullId}/turns`);
  }, 60_000);

  test('task-page links to OTHER tasks carry their codes', async () => {
    const parentId = await createTask(ctx, 'Code URL parent', 'x');
    const created = await ctx.lazy([
      'create', '--goal', 'Code URL child', '--code', 'code-url-child', '--parent', parentId,
    ]);
    expect(created.exitCode).toBe(0);
    const shown = JSON.parse((await ctx.lazy(['show', 'code-url-child', '--json'])).stdout) as {
      id: string;
    };

    const page = await (await fetch(`${base}/tasks/${parentId}/subtasks`)).text();
    // The subtasks tab's rows name the child by its code.
    expect(page).toContain('/tasks/code-url-child');
    expect(page).not.toContain(`href="/tasks/${shown.id}"`);
  }, 60_000);

  test('a duplicated code falls back to the id on every link that knows the dup set', async () => {
    // `lazy create` refuses a duplicate code, but `lazy edit --code` does not —
    // the store can legitimately end up with two tasks sharing one code. The
    // code is then ambiguous: no link built from it may be emitted, or it
    // resolves to whichever task the resolver names the winner (or refuses as
    // an ambiguity error) — either way the engineer lands on the wrong task.
    const a = await createTask(ctx, 'Dup A', 'x');
    const b = await createTask(ctx, 'Dup B', 'x');
    const aFull = (readTaskJson(ctx.root, a) as { id: string }).id;
    const recoded = await ctx.lazy(['edit', a, '--code', 'dup-code-urls']);
    expect(recoded.exitCode).toBe(0);
    const recodedB = await ctx.lazy(['edit', b, '--code', 'dup-code-urls']);
    expect(recodedB.exitCode).toBe(0);

    // The listing knows both tasks: its rows fall back to the ids.
    const list = await (await fetch(`${base}/tasks`)).text();
    expect(list).not.toContain('href="/tasks/dup-code-urls"');
    expect(list).toContain(`href="/tasks/${aFull}">dup-code-urls</a>`);

    // A task page knows both codes too (it loads the same tables for its own
    // links): its edit/review links fall back to the id.
    const page = await (await fetch(`${base}/tasks/${aFull}`)).text();
    expect(page).not.toContain('href="/tasks/dup-code-urls');
    expect(page).toContain(`/tasks/${aFull}/review`);
    expect(page).toContain(`/tasks/${aFull}/turns`);

    // The dashboard knows the set too: its recently-created rows (fresh tasks
    // land there even when they are backlog) link by id.
    const dash = await (await fetch(`${base}/`)).text();
    expect(dash).toContain('Recently Created');
    expect(dash).not.toContain('href="/tasks/dup-code-urls"');
    expect(dash).toContain(`href="/tasks/${aFull}">dup-code-urls</a>`);

    // The edit page's form action falls back to the id as well — a code-URL
    // POST that resolved to a random one of the two tasks would edit the
    // wrong one.
    const edit = await (await fetch(`${base}/tasks/${aFull}/edit`)).text();
    expect(edit).not.toContain('/tasks/dup-code-urls');
    expect(edit).toContain(`action="/tasks/${aFull}/edit"`);
  }, 60_000);

  // INVARIANT: escaping a segment on generation and decoding it on resolution
  // are a PAIR — an address this UI EMITS must be one it can also SERVE.
  // Generation escapes each segment exactly once; the router used to split the
  // raw pathname and match it verbatim, so a code carrying a URL-significant
  // character was escaped into an address that then resolved to no task at
  // all. Unreachable by every spelling is worse than never linking by code.
  //
  // The code is seeded straight into storage on purpose: `lazy create` and
  // `lazy edit --code` both validate codes to the DNS-label charset, so this
  // is latent today and this test is what keeps it closed if codes ever widen
  // (raised separately as the unvalidated `proposed_code` promotion path).
  // The round trip never spells the escaping itself — it reads back the href
  // the UI emitted and requests THAT — so it cannot pass by agreeing with a
  // hardcoded encoding that the server does not use.
  test('a code with a URL-significant character round-trips: generated link → request → resolved task', async () => {
    const taskId = await createTask(ctx, 'Wide code task', 'x');
    const stored = readTaskJson(ctx.root, taskId) as { id: string; code: string | null };
    const fullId = stored.id;
    writeTaskJson(ctx.root, taskId, { ...stored, code: 'my code' });

    // GENERATE: the task page (reached by uuid) emits this task's own links.
    const byId = await fetch(`${base}/tasks/${fullId}`);
    expect(byId.status).toBe(200);
    const page = await byId.text();
    expect(page).toContain('Wide code task');

    // The emitted segment is escaped exactly once — `my%20code`, never a raw
    // space and never the double-escaped `my%2520code`.
    const href = page.match(/href="(\/tasks\/[^"]*?)\/turns"/)?.[1];
    expect(href).toBe('/tasks/my%20code');

    // REQUEST + RESOLVE: the address the UI just emitted serves this task.
    const byCode = await fetch(`${base}${href}`);
    expect(byCode.status).toBe(200);
    const codePage = await byCode.text();
    expect(codePage).toContain('Wide code task');
    expect(codePage).toContain(`data-lz-task-id="my%20code"`);

    // A tab under that address resolves too — the decode is at the router's
    // split, so it is not one lucky route.
    const turns = await fetch(`${base}${href}/turns`);
    expect(turns.status).toBe(200);

    // And the uuid permalink still resolves, as it must for every code shape.
    expect((await fetch(`${base}/tasks/${fullId}`)).status).toBe(200);
  }, 60_000);
});