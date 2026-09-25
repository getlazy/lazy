/**
 * E2E for the search grammar: the `task:` field, its substring semantics, the
 * retired `code:` spelling, and — the reason this suite exists — that every
 * client asking the daemon the same question gets the same answer.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';

interface ApiSearchBody {
  results: Array<{ task_code: string | null; entity_type: string }>;
}

async function createCodedTask(ctx: TestContext, code: string, goal: string): Promise<void> {
  const result = await ctx.lazy(['create', '--goal', goal, '--code', code]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create ${code}: ${result.stderr}\n${result.stdout}`);
  }
}

describe('search grammar', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));

    // Three codes containing "spike" in three different positions, plus one
    // that does not — the shape that exposed the old exact-equality match.
    await createCodedTask(ctx, 'spike-vm-isolation', 'Investigate VM isolation vehicles');
    await createCodedTask(ctx, 'publish-runner-spike', 'Design runner image publishing');
    await createCodedTask(ctx, 'do-spike-thing', 'A code with spike in the middle');
    await createCodedTask(ctx, 'unrelated-widget', 'Nothing to do with the others');
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('task: matches the code as a substring, in any position', async () => {
    const result = await ctx.lazy(['search', 'task:spike']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('spike-vm-isolation');
    expect(result.stdout).toContain('publish-runner-spike');
    expect(result.stdout).toContain('do-spike-thing');
    expect(result.stdout).not.toContain('unrelated-widget');
  });

  test('task: matching a whole code still works', async () => {
    const result = await ctx.lazy(['search', 'task:spike-vm-isolation']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('spike-vm-isolation');
    expect(result.stdout).not.toContain('publish-runner-spike');
  });

  // INVARIANT: one query, one answer, whichever client asked. The dashboard
  // used to call storage.search() directly instead of the daemon's search
  // engine, so a structured query was parsed by the CLI and run as a raw regex
  // by the web UI: `code:spike` returned 0 from `lazy search` and 4 in the
  // browser, for the same store. Any new surface goes through executeSearch.
  test('CLI, /search and /api/search return the same tasks for the same query', async () => {
    const cli = await ctx.lazy(['search', 'task:spike']);
    expect(cli.exitCode).toBe(0);

    const page = await fetch(`${base}/search?q=${encodeURIComponent('task:spike')}`);
    expect(page.status).toBe(200);
    const pageHtml = await page.text();

    const api = await fetch(`${base}/api/search?q=${encodeURIComponent('task:spike')}`);
    expect(api.status).toBe(200);
    const apiCodes = new Set(
      ((await api.json()) as ApiSearchBody).results
        .map(r => r.task_code)
        .filter((c): c is string => c !== null),
    );

    const expected = ['spike-vm-isolation', 'publish-runner-spike', 'do-spike-thing'];
    for (const code of expected) {
      expect(cli.stdout).toContain(code);
      expect(pageHtml).toContain(code);
      expect(apiCodes.has(code)).toBe(true);
    }
    expect(apiCodes.has('unrelated-widget')).toBe(false);
    // The search RESULTS must not name the excluded task. The grammar cheat
    // sheet on the same page mentions no task codes, so a plain absence check
    // is safe here.
    expect(pageHtml).not.toContain('unrelated-widget');
  });

  test('the retired code: spelling is rejected on every surface, naming task:', async () => {
    const cli = await ctx.lazy(['search', 'code:spike']);
    expect(cli.exitCode).not.toBe(0);
    expect(`${cli.stderr}${cli.stdout}`).toContain('task:spike');

    const page = await fetch(`${base}/search?q=${encodeURIComponent('code:spike')}`);
    expect(page.status).toBe(400);
    expect(await page.text()).toContain('task:spike');
  });

  test('the search page carries the grammar, and it advertises task: not code:', async () => {
    const html = await (await fetch(`${base}/search`)).text();
    expect(html).toContain('Query syntax');
    expect(html).toContain('task:&lt;text&gt;');
    expect(html).toContain('in:turns');
    expect(html).toContain('has:commits');
    expect(html).toContain('created:&gt;YYYY-MM-DD');
    expect(html).not.toContain('code:&lt;value&gt;');
  });

  test('lazy search --help describes the same grammar as the page', async () => {
    const help = await ctx.lazy(['search', '--help']);
    expect(help.stdout).toContain('task:<text>');
    expect(help.stdout).toContain('Field filters:');
    expect(help.stdout).toContain('has:commits');
    expect(help.stdout).not.toContain('code:<value>');
  });
});
