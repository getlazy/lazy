/**
 * E2E for the web shared-memory surface: the live listing, create / edit /
 * delete, the compact page, and the JSON listing.
 *
 * The daemon serves these routes in-process. Reads go through its Storage;
 * writes go through MemoryActions (src/daemon/memory-service.ts) so authoring
 * validation and compact orchestration stay on one path with the CLI. After
 * each mutating POST the assertions check the STORE, not just the rendered
 * page — a 303 to a page that looks right while the write never landed is
 * the failure this exists to catch.
 *
 * Bulk seeding writes `memories.json` directly: mechanical compact only pays
 * off at ~50+ records, and 60 `lazy memory save` subprocesses would dominate
 * this file. A handful of records still go through the CLI so the real
 * authoring path is what list/show/history render.
 *
 * Requests go through `signInToDashboard` — memory routes are served by
 * `createWebRequestHandler` and therefore sit behind `guardDashboardRequest`.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import {
  writeMemoriesFile,
  readMemoriesFile,
  readMemoryCompactFile,
} from '../helpers/storage';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';

function seedRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    name: 'deploy-window',
    description: 'Deploys are Tue/Thu 10am',
    type: 'reference',
    body: 'Ask before off-cycle deploys.',
    created_at: now,
    updated_at: now,
    created_by: 'human',
    updated_by: 'human',
    revision: 1,
    ...overrides,
  };
}

/** Enough records that mechanical compact genuinely shrinks injection. */
function seedMany(count = 60): Record<string, unknown>[] {
  const now = Date.now();
  const records: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    records.push({
      name: `store-record-number-${i}`,
      description: `A typical one-line description for record ${i} of the shared memory store.`,
      type: 'project',
      body: `Body for record ${i}.`,
      created_at: now,
      updated_at: now,
      created_by: 'human',
      updated_by: 'human',
      revision: 1,
    });
  }
  return records;
}

/**
 * Form POST as the browser would send it.
 *
 * Default `redirect: 'manual'` so a 303 is observable. For streaming
 * endpoints (compact POST) pass `'follow'` and drain `res.text()` before
 * asserting on the store — fetch resolves when headers arrive, and compact
 * only writes after the generator finishes inside that stream.
 */
async function postForm(
  fetch: DashboardFetch,
  url: string,
  fields: Record<string, string>,
  redirect: RequestRedirect = 'manual',
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    redirect,
  });
}

describe('web shared memory', () => {
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

  test('an empty store says so rather than rendering a blank table', async () => {
    const res = await fetch(`${base}/settings/memory`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('No memory records yet');
    expect(html).toContain('/memory/new');
    expect(html).toContain('/memory/compact');
  });

  test('GET /memory 308-redirects to the Settings Memories tab', async () => {
    const redirected = await fetch(`${base}/memory?all=1`, { redirect: 'manual' });
    expect(redirected.status).toBe(308);
    expect(redirected.headers.get('location')).toMatch(/\/settings\/memory\?all=1$/);
  });

  test('every page links to Settings from the nav', async () => {
    const html = await (await fetch(`${base}/tasks`)).text();
    expect(html).toContain('href="/settings"');
    expect(html).not.toContain('href="/memory">Memory</a>');
  });

  test('the listing shows live records and hides tombstones until asked', async () => {
    const live = seedRecord({ name: 'deploy-window', description: 'Deploys are Tue/Thu 10am' });
    const gone = seedRecord({
      name: 'retired-policy',
      description: 'No longer current',
      deleted_at: Date.now(),
      deleted_by: 'human',
    });
    writeMemoriesFile(ctx.root, [live, gone]);

    const index = await (await fetch(`${base}/settings/memory`)).text();
    expect(index).toContain('deploy-window');
    expect(index).toContain('Deploys are Tue/Thu 10am');
    expect(index).not.toContain('retired-policy');

    const all = await (await fetch(`${base}/settings/memory?all=1`)).text();
    expect(all).toContain('deploy-window');
    expect(all).toContain('retired-policy');
    expect(all).toContain('removed');
  });

  test('the detail page renders the body, type, and write history', async () => {
    const save = await ctx.lazy([
      'memory', 'save', 'deploy-window',
      '-t', 'reference',
      '-d', 'Deploys are Tue/Thu 10am',
      '-b', 'Ask before off-cycle deploys.',
    ]);
    expectSuccess(save);

    const res = await fetch(`${base}/memory/deploy-window`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('deploy-window');
    expect(html).toContain('Deploys are Tue/Thu 10am');
    expect(html).toContain('Ask before off-cycle deploys.');
    expect(html).toContain('reference');
    expect(html).toContain('create');
    expect(html).toContain('/memory/deploy-window/remove');
  });

  test('an unknown name 404s; a name that is not a slug 400s', async () => {
    const missing = await fetch(`${base}/memory/no-such-record`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('No memory record named');

    const bad = await fetch(`${base}/memory/${encodeURIComponent('!!!')}`);
    expect(bad.status).toBe(400);
  });

  test('creating a record via POST lands in the store and redirects to it', async () => {
    const res = await postForm(fetch, `${base}/memory`, {
      name: 'VM Credentials Idea',
      type: 'project',
      description: 'Inject VM credentials at boot',
      body: 'Push to a host-side clone at each turn end.',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/memory/vm-credentials-idea');

    const stored = readMemoriesFile(ctx.root).find((m) => m.name === 'vm-credentials-idea');
    expect(stored).toBeDefined();
    expect(stored!.description).toBe('Inject VM credentials at boot');
    expect(stored!.body).toBe('Push to a host-side clone at each turn end.');
    expect(stored!.type).toBe('project');
    expect(stored!.created_by).toBe('human');

    const show = await (await fetch(`${base}/memory/vm-credentials-idea`)).text();
    expect(show).toContain('Inject VM credentials at boot');
    expect(show).toContain('host-side clone');
  });

  test('a validation error re-renders the form with the typed values, never discards them', async () => {
    const res = await postForm(fetch, `${base}/memory`, {
      name: 'half-written',
      type: 'feedback',
      description: 'Guidance we almost saved',
      body: '',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('needs a body');
    expect(html).toContain('half-written');
    expect(html).toContain('Guidance we almost saved');
    expect(html).toContain('value="feedback"');
    expect(readMemoriesFile(ctx.root)).toHaveLength(0);
  });

  test('updating a record via POST supersedes it and appends history', async () => {
    expectSuccess(await ctx.lazy([
      'memory', 'save', 'deploy-window',
      '-t', 'reference',
      '-d', 'Deploys are Tue/Thu 10am',
      '-b', 'Ask first.',
    ]));

    const res = await postForm(fetch, `${base}/memory/deploy-window`, {
      type: 'reference',
      description: 'Deploys are Tue/Thu 10am',
      body: 'Ask, then wait for the window.',
    });
    expect(res.status).toBe(303);

    const stored = readMemoriesFile(ctx.root).find((m) => m.name === 'deploy-window')!;
    expect(stored.body).toBe('Ask, then wait for the window.');
    expect(stored.revision).toBe(2);

    const show = await (await fetch(`${base}/memory/deploy-window`)).text();
    expect(show).toContain('Ask, then wait for the window.');
    expect(show).toContain('update');
  });

  test('removing a record tombstones it; the live list hides it, the all view keeps it', async () => {
    expectSuccess(await ctx.lazy([
      'memory', 'save', 'deploy-window',
      '-t', 'reference',
      '-d', 'Deploys are Tue/Thu 10am',
      '-b', 'Ask first.',
    ]));

    const confirm = await fetch(`${base}/memory/deploy-window/remove`);
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain('Remove deploy-window?');

    const res = await postForm(fetch, `${base}/memory/deploy-window/remove`, {});
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/\/settings\/memory$/);

    const stored = readMemoriesFile(ctx.root).find((m) => m.name === 'deploy-window')!;
    expect(stored.deleted_at).toBeDefined();
    expect(stored.deleted_by).toBe('human');

    const live = await (await fetch(`${base}/settings/memory`)).text();
    expect(live).not.toContain('href="/memory/deploy-window"');

    const all = await (await fetch(`${base}/settings/memory?all=1`)).text();
    expect(all).toContain('deploy-window');
    expect(all).toContain('removed');
  });

  test('the compact page with no artifact says the full index is injected', async () => {
    writeMemoriesFile(ctx.root, [seedRecord()]);
    const html = await (await fetch(`${base}/memory/compact`)).text();
    expect(html).toContain('No memory compact yet');
    expect(html).toContain('full index');
    expect(html).toContain('mechanical');
    expect(html).toContain('value="auto"');
  });

  // Mechanical compact is the test path: no model, and it only writes when
  // the candidate actually shrinks injection (which needs a large store).
  test('mechanical compact POST streams progress, saves, and the compact page shows it', async () => {
    writeMemoriesFile(ctx.root, seedMany(60));

    const res = await postForm(fetch, `${base}/memory/compact`, { mode: 'mechanical' }, 'follow');
    expect(res.status).toBe(200);
    const streamed = await res.text();
    expect(streamed).toContain('id="memory-compact-progress"');
    expect(streamed).toContain('Compacting 60 memory record(s)');
    expect(streamed).toContain('id="memory-compact-result"');
    expect(streamed).toContain('Compacted 60 memory record(s) using mechanical');
    expect(streamed).not.toContain('Request Timed Out');

    const saved = readMemoryCompactFile(ctx.root);
    expect(saved).not.toBeNull();
    expect(saved!.method).toBe('mechanical');
    expect((saved!.covered as unknown[]).length).toBe(60);

    const page = await (await fetch(`${base}/memory/compact`)).text();
    expect(page).toContain('covering 60 record(s)');
    expect(page).toContain('Clear compact');
  }, 30_000);

  test('clearing the compact drops the artifact; injection falls back to the index', async () => {
    writeMemoriesFile(ctx.root, seedMany(60));
    const compactRes = await postForm(fetch, `${base}/memory/compact`, { mode: 'mechanical' }, 'follow');
    // Drain the stream — fetch resolves at headers, and compact writes only
    // after the generator finishes inside that stream.
    await compactRes.text();
    expect(readMemoryCompactFile(ctx.root)).not.toBeNull();

    const res = await postForm(fetch, `${base}/memory/compact/clear`, {});
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Cleared the memory compact');
    expect(readMemoryCompactFile(ctx.root)).toBeNull();
  }, 30_000);

  test('the JSON listing ships index fields and never bodies', async () => {
    writeMemoriesFile(ctx.root, [seedRecord({
      name: 'secret-knowledge',
      description: 'A one-line summary',
      body: 'secret-record-body-must-not-leak',
    })]);

    const res = await fetch(`${base}/api/memory`);
    expect(res.status).toBe(200);
    const payload = await res.json() as {
      total: number;
      records: Array<Record<string, unknown>>;
    };
    expect(payload.total).toBe(1);
    expect(payload.records[0].name).toBe('secret-knowledge');
    expect(payload.records[0].type).toBe('reference');
    expect(payload.records[0].description).toBe('A one-line summary');
    expect(payload.records[0].revision).toBe(1);
    expect(payload.records[0]).not.toHaveProperty('body');
    // INVARIANT: the listing endpoint is a metadata projection. Bodies are
    // only ever served by the detail page.
    expect(JSON.stringify(payload)).not.toContain('secret-record-body-must-not-leak');
  });
});
