/**
 * E2E coverage for the cross-task raised-items queue — `lazy raised` and the
 * `/raised` inbox, including recurrences, ordering and the blocking filter.
 *
 * Seeding is direct-to-storage: raised items have no human create CLI (agents
 * record them with `lazy_raise`), so a queue holding items of both kinds and
 * several ages cannot be produced through the CLI.
 *
 * This suite was `followups.test.ts` before follow-ups and raised items became
 * one entity. Every case it used to make about follow-ups is now made about a
 * NON-BLOCKING raised item, which is what a follow-up is.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { randomUUID } from 'crypto';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, extractTaskId } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
import { readTaskJson, writeTaskJson, writeRaisedItemsFile } from '../helpers/storage';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';

/** Seed raised items on a task. `blocking` defaults to false — a follow-up. */
function writeRaised(
  root: string,
  shortId: string,
  items: Array<{ id: string; content: string; created_at: number; blocking?: boolean }>,
): void {
  writeRaisedItemsFile(root, shortId, items.map((i) => ({
    task_id: shortId,
    blocking: false,
    status: 'open',
    ...i,
  })));
}

describe('lazy raised', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('empty store says so', async () => {
    const result = await ctx.lazy(['raised']);
    expectSuccess(result);
    expectOutput(result, 'No raised items match');
  });

  test('lists items and shows recurrence size', async () => {
    const taskA = await createTask(ctx, 'Task A');
    const taskB = await createTask(ctx, 'Task B');
    const now = Date.now();
    const shared = 'Extract retry helper into shared module';

    writeRaised(ctx.root, taskA, [
      { id: randomUUID(), content: shared, created_at: now - 86400000 },
    ]);
    writeRaised(ctx.root, taskB, [
      { id: randomUUID(), content: shared, created_at: now - 43200000 },
    ]);

    const result = await ctx.lazy(['raised']);
    expectSuccess(result);
    expectOutput(result, '2 raised item');
    expectOutput(result, '2'); // recurrence size column
    expectOutput(result, shared.slice(0, 30));
  });

  // The counts lead the listing because "what is between me and a merge" and
  // "what is merely proposed" are different questions — a single total buries
  // the first inside the second.
  test('the listing counts open blocking and open non-blocking separately', async () => {
    const task = await createTask(ctx, 'Mixed task');
    const now = Date.now();
    writeRaised(ctx.root, task, [
      { id: randomUUID(), content: 'Ship option A or option B?', created_at: now, blocking: true },
      { id: randomUUID(), content: 'The importer has no timeout', created_at: now },
      { id: randomUUID(), content: 'Socket errors are logged twice', created_at: now },
    ]);

    const result = await ctx.lazy(['raised']);
    expectSuccess(result);
    // Counts and column both read from the shared vocabulary now, so `lazy
    // raised` and the web say the same two words about the same flag. The
    // column carries the LABEL and not the emoji: it is padEnd-ed, and an
    // emoji's terminal width varies by emulator.
    expectOutput(result, '1 open Blocking');
    expectOutput(result, '2 open FYI');
    // The gate column marks which is which.
    expectOutput(result, 'GATE');
    expectOutput(result, 'Blocking');
    expectOutput(result, 'FYI');
    expect(result.stdout).not.toContain('🛑');
  });

  test('--blocking and --non-blocking narrow to one kind', async () => {
    const task = await createTask(ctx, 'Filter task');
    const now = Date.now();
    writeRaised(ctx.root, task, [
      { id: randomUUID(), content: 'Gating question about this diff', created_at: now, blocking: true },
      { id: randomUUID(), content: 'Orthogonal importer timeout note', created_at: now },
    ]);

    const blocking = await ctx.lazy(['raised', '--blocking']);
    expectSuccess(blocking);
    expectOutput(blocking, 'Gating question');
    expect(blocking.stdout.includes('Orthogonal importer')).toBe(false);

    const nonBlocking = await ctx.lazy(['raised', '--non-blocking']);
    expectSuccess(nonBlocking);
    expectOutput(nonBlocking, 'Orthogonal importer');
    expect(nonBlocking.stdout.includes('Gating question')).toBe(false);
  });

  test('--blocking and --non-blocking together are refused, not silently merged', async () => {
    const result = await ctx.lazy(['raised', '--blocking', '--non-blocking']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('opposites');
  });

  // The old spelling stays for one release. The notice goes to stderr so a
  // script piping stdout keeps parsing exactly what it parsed before.
  test('lazy followups still lists, warning on stderr only', async () => {
    const task = await createTask(ctx, 'Alias task');
    writeRaised(ctx.root, task, [
      { id: randomUUID(), content: 'Recorded before the rename', created_at: Date.now() },
    ]);

    const result = await ctx.lazy(['followups']);
    expectSuccess(result);
    expectOutput(result, 'Recorded before the rename');
    expect(result.stderr).toContain('lazy raised');
    expect(result.stdout).not.toContain('lazy raised is');
  });

  test('recurring recurrences section renders for near-duplicate items', async () => {
    const taskA = await createTask(ctx, 'Recurrence task A');
    const taskB = await createTask(ctx, 'Recurrence task B');
    const now = Date.now();
    const shared = 'Extract retry helper into shared module for all callers';

    writeRaised(ctx.root, taskA, [
      { id: randomUUID(), content: shared, created_at: now - 86400000 },
    ]);
    writeRaised(ctx.root, taskB, [
      { id: randomUUID(), content: shared, created_at: now - 43200000 },
    ]);

    // -r hits the recurring-items branch (and the bold count formatter).
    //
    // The flag was `-c` / `--clusters-only` and the heading said "Recurring
    // clusters" until 2026-09-20, when "cluster" became the name of the task
    // type that drives its children concurrently. One word, one meaning: what
    // this groups is a RECURRENCE, so the flag is `-r` / `--recurring-only`,
    // the size filter is `--min-recurrence`, and the column is `REC`. The
    // grouping, ordering and filtering are untouched.
    const result = await ctx.lazy(['raised', '-r']);
    expectSuccess(result);
    expectOutput(result, 'Recurring items');
    expectOutput(result, '2×');
    expectOutput(result, shared.slice(0, 40));
  });

  test('--status complete-only filters originating task status', async () => {
    const open = await createTask(ctx, 'Open task');
    const done = await createTask(ctx, 'Done task');
    const now = Date.now();

    writeRaised(ctx.root, open, [
      { id: randomUUID(), content: 'open task note', created_at: now },
    ]);
    writeRaised(ctx.root, done, [
      { id: randomUUID(), content: 'done task note', created_at: now },
    ]);

    const doneTask = readTaskJson(ctx.root, done);
    doneTask.status = 'complete';
    writeTaskJson(ctx.root, done, doneTask);

    const result = await ctx.lazy(['raised', '--status', 'complete-only']);
    expectSuccess(result);
    expectOutput(result, 'done task note');
    expect(result.stdout.includes('open task note'), 'should hide open-task item').toBe(false);
  });
});

describe('web raised-items inbox', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('renders the raised-items page', async () => {
    const taskId = await createTask(ctx, 'Web raised task');
    writeRaised(ctx.root, taskId, [
      { id: randomUUID(), content: 'Dashboard raised note', created_at: Date.now() },
    ]);

    const res = await fetch(`${base}/raised`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Raised items');
    expect(html).toContain('Needs attention');
    expect(html).toContain('Dashboard raised note');
    // Both kinds are one list, filtered rather than split across two pages —
    // and the filters are labelled from the shared vocabulary, so they read as
    // the badges in the Gate column do.
    expect(html).toContain('Blocking');
    expect(html).toContain('FYI');
  });

  // The old URL is in prompts, bookmarks and older task text; it moves rather
  // than 404s, and 308 keeps the method so a JSON caller is not downgraded.
  test('/followups permanently redirects to /raised', async () => {
    const res = await fetch(`${base}/followups`, { redirect: 'manual' });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toMatch(/\/raised$/);

    const api = await fetch(`${base}/api/followups`, { redirect: 'manual' });
    expect(api.status).toBe(308);
    expect(api.headers.get("location")).toMatch(/\/api\/raised$/);
  });

  test('?gate= narrows the page to one kind', async () => {
    const taskId = await createTask(ctx, 'Gate filter task');
    const now = Date.now();
    writeRaised(ctx.root, taskId, [
      { id: randomUUID(), content: 'A gating scope question', created_at: now, blocking: true },
      { id: randomUUID(), content: 'An orthogonal proposal', created_at: now },
    ]);

    const blocking = await (await fetch(`${base}/raised?gate=blocking`)).text();
    expect(blocking).toContain('A gating scope question');
    expect(blocking).not.toContain('An orthogonal proposal');

    const nonBlocking = await (await fetch(`${base}/raised?gate=non-blocking`)).text();
    expect(nonBlocking).toContain('An orthogonal proposal');
    expect(nonBlocking).not.toContain('A gating scope question');
  });

  test('detail permalink renders body and similar section', async () => {
    const taskId = await createTask(ctx, 'Detail raised task');
    const itemId = randomUUID();
    writeRaised(ctx.root, taskId, [
      { id: itemId, content: 'Extract retry helper into shared module for callers', created_at: Date.now() },
    ]);

    const res = await fetch(`${base}/raised/${itemId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Extract retry helper');
    expect(html).toContain('Similar raised items');
  });

  // Re-flagging is a human/builder act — no agent tool changes it — so the
  // page carries the control and the flag survives the round trip.
  test('the detail page re-flags an item', async () => {
    const taskId = await createTask(ctx, 'Reflag task');
    const itemId = randomUUID();
    writeRaised(ctx.root, taskId, [
      { id: itemId, content: 'Should this hold up the merge?', created_at: Date.now() },
    ]);

    const res = await fetch(`${base}/raised/${itemId}/blocking`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'blocking=true',
      redirect: 'manual',
    });
    expect([200, 302, 303]).toContain(res.status);

    const listed = await (await fetch(`${base}/raised?gate=blocking`)).text();
    expect(listed).toContain('Should this hold up the merge?');
  });
});

/**
 * The order the inbox renders in, and the URL that asks for it.
 *
 * The page is a triage queue, so "which of these did I not look at yet" is
 * answered by the order — these seed rows that differ on every sortable column
 * and assert what actually comes back through the daemon, not just what the
 * template would render for a hand-built listing (that is unit-tested).
 */
describe('web raised-items inbox ordering', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  /** The note titles, in the order the inbox table renders them. */
  function rowTitles(html: string): string[] {
    const cells = html.matchAll(/<td class="wrap"><a href="\/raised\/[^"]+">([^<]*)<\/a>/g);
    return [...cells].map((m) => m[1]!);
  }

  const HOUR = 60 * 60 * 1000;

  // Alphabetically M < N < O, so title order is distinguishable from both age
  // order and task order — and no two share enough vocabulary to recurrence.
  const MIDDLE = 'Middle note: cache eviction has no metrics';
  const NEWEST = 'Newest note: flag parser drops the second value';
  const OLDEST = 'Oldest note: socket timeouts are unbounded';

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));

    // Two tasks, so the Task column has something to rank on, and three notes
    // whose ages, titles and task codes disagree with each other — an order
    // that looks right by accident under one column is wrong under the others.
    // Their wording is deliberately disjoint: near-duplicates recurrence, and the
    // inbox collapses a recurrence to one representative row, which would hide the
    // very rows whose order is under test.
    const zebra = await ctx.lazy(['create', '--goal', 'Zebra task', '--code', 'zzz-task']);
    expectSuccess(zebra);
    const apple = await ctx.lazy(['create', '--goal', 'Apple task', '--code', 'aaa-task']);
    expectSuccess(apple);
    const zebraId = extractTaskId(zebra.stdout);
    const appleId = extractTaskId(apple.stdout);

    const now = Date.now();
    writeRaised(ctx.root, zebraId, [
      { id: randomUUID(), content: MIDDLE, created_at: now - 2 * HOUR },
    ]);
    writeRaised(ctx.root, appleId, [
      { id: randomUUID(), content: NEWEST, created_at: now - 1 * HOUR },
      { id: randomUUID(), content: OLDEST, created_at: now - 3 * HOUR },
    ]);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('with no ?sort= the queue is newest first, and says so', async () => {
    const html = await (await fetch(`${base}/raised`)).text();
    expect(html).toContain('Sorted by <strong>age</strong>, newest first');
    expect(rowTitles(html)).toEqual([NEWEST, MIDDLE, OLDEST]);
  });

  test('?sort=age flips the queue to oldest first', async () => {
    const html = await (await fetch(`${base}/raised?sort=age`)).text();
    expect(html).toContain('Sorted by <strong>age</strong>, oldest first');
    expect(html).toContain('Age ▲');
    expect(rowTitles(html)).toEqual([OLDEST, MIDDLE, NEWEST]);
  });

  // The service owns this ordering; the page maps its column onto it. If that
  // mapping is dropped the rows come back in age order while the header still
  // claims Task — the failure this pins. Within one task the service breaks the
  // tie by age, so the two apple notes stay in oldest-first order under `asc`.
  test('?sort=task ranks by the originating task code', async () => {
    const html = await (await fetch(`${base}/raised?sort=task`)).text();
    expect(rowTitles(html)).toEqual([OLDEST, NEWEST, MIDDLE]);
    expect(await (await fetch(`${base}/raised?sort=-task`)).text().then(rowTitles))
      .toEqual([MIDDLE, NEWEST, OLDEST]);
  });

  // Title has no ordering in the service, so this exercises the page's own
  // ranking end to end — including that it survives the round trip through the
  // daemon rather than being re-sorted back into age order.
  test('?sort=title ranks alphabetically, which the service cannot do', async () => {
    const html = await (await fetch(`${base}/raised?sort=title`)).text();
    expect(html).toContain('Sorted by <strong>title</strong>, A to Z');
    expect(rowTitles(html)).toEqual([MIDDLE, NEWEST, OLDEST]);
    expect(await (await fetch(`${base}/raised?sort=-title`)).text().then(rowTitles))
      .toEqual([OLDEST, NEWEST, MIDDLE]);
  });

  test('an unknown sort field falls back to the default instead of erroring', async () => {
    const res = await fetch(`${base}/raised?sort=-nonsense`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Sorted by <strong>age</strong>, newest first');
    expect(rowTitles(html)[0]).toBe(NEWEST);
  });

  test('a filter keeps the chosen sort, and the sort links keep the filter', async () => {
    const html = await (await fetch(`${base}/raised?all=1&sort=title`)).text();
    // Filter buttons carry the order the reader picked (and the filter they
    // compose with — Finished tasks narrows the All view, it does not leave it).
    expect(html).toContain('href="/raised?all=1&amp;status=complete-only&amp;sort=title"');
    // ...and the column headers carry the filter they are looking through —
    // including the one that lands back on the default order, where the sort
    // param drops out of the URL but the filter must not.
    expect(html).toContain('href="/raised?all=1&amp;sort=-task"');
    expect(html).toContain('href="/raised?all=1" class="sort-link">Age</a>');
    expect(rowTitles(html)[0]).toBe(MIDDLE);

    // Both at once still resolves to both.
    const filtered = await (await fetch(`${base}/raised?all=1&sort=-task`)).text();
    expect(rowTitles(filtered)[0]).toBe(MIDDLE);
    expect(filtered).toContain('Task ▼');
  });

  test('the JSON API honours the same ?sort=', async () => {
    const res = await fetch(`${base}/api/raised?sort=title`);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ title: string }> };
    expect(body.items.map((i) => i.title)).toEqual([MIDDLE, NEWEST, OLDEST]);
  });
});
