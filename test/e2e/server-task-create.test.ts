/**
 * E2E for the web New-task form: GET /tasks/new, POST into backlog, Start now
 * through the same daemon start path the task-page Start button uses.
 *
 * The daemon performs the create (src/daemon/create-task.ts via TaskActions).
 * The web layer parses the form and shows the daemon's error text on failure.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { successScenario } from '../helpers/fake-claude';
import { ACTION_DIALOG_HEADER } from '../../src/server/action-run';

describe('lazy web create task', () => {
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

  const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${base}/tasks/new`, {
      method: 'POST',
      body: new URLSearchParams(fields),
      redirect: 'manual',
      headers,
    });

  test('the Tasks list and a task page offer New task / New subtask', async () => {
    const parentId = await createTask(ctx, 'Existing parent', 'Parent prompt');
    const list = await (await fetch(`${base}/tasks`)).text();
    expect(list).toContain('href="/tasks/new"');
    expect(list).toContain('New task');

    const detail = await (await fetch(`${base}/tasks/${parentId}`)).text();
    expect(detail).toMatch(/href="\/tasks\/new\?parent=[^"]+"/);
    expect(detail).toContain('New subtask');
  });

  test('GET /tasks/new renders the create form, and ?parent= pre-fills', async () => {
    const parentId = await createTask(ctx, 'Parent for prefill', 'x');
    const blank = await (await fetch(`${base}/tasks/new`)).text();
    expect(blank).toContain('name="goal"');
    expect(blank).toContain('name="prompt"');
    expect(blank).toContain('name="code"');
    expect(blank).toContain('name="parent"');
    expect(blank).toContain('name="type"');
    expect(blank).toContain('name="agent"');
    expect(blank).toContain('name="model"');
    expect(blank).toContain('name="effort"');
    expect(blank).toContain('name="start_now"');
    expect(blank).toContain('id="lz-action-dialog"');

    const prefilled = await (await fetch(`${base}/tasks/new?parent=${parentId}`)).text();
    expect(prefilled).toContain(`value="${parentId}"`);
  });

  test('the agent picker offers the project\'s [agents.<name>] profiles first', async () => {
    // INVARIANT: the web agent picker offers PROFILES, the project's own ahead
    // of the implicit per-harness built-ins and each showing what it runs. A
    // flat list of harness names is what led a human to select an "agent" their
    // lazy.toml never defined.
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    expect(before).not.toMatch(/^\s*\[agents\./m);
    await writeFile(
      configPath,
      `${before}\n[agents.company-tokens-cursor]\nharness = "cursor"\nmodel = "claude-sonnet-5"\n`,
    );

    for (const path of ['/tasks/new', `/tasks/${await createTask(ctx, 'Pick an agent', 'x')}/edit`]) {
      const page = await (await fetch(`${base}${path}`)).text();
      expect(page).toContain('<optgroup label="Configured profiles (lazy.toml)">');
      expect(page).toContain('company-tokens-cursor — cursor · claude-sonnet-5');
      expect(page).toContain('<optgroup label="Built-in profiles">');
      // Configured before built-in, and the built-ins are still selectable.
      expect(page.indexOf('company-tokens-cursor')).toBeLessThan(page.indexOf('Built-in profiles'));
      expect(page).toContain('>claude-code — claude-code');
      expect(page).toContain('[agents.&lt;name&gt;]');
    }
  });

  test('a lazy.toml the picker cannot read is shown as degraded, not as built-ins', async () => {
    // INVARIANT: the degraded agent list is VISIBLY degraded. A bad
    // [agents.<name>] block is the likeliest reason config cannot be read —
    // exactly when a human is on their way to fix a profile — so the page must
    // not quietly present lazy's built-in agents as if they were the answer.
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    await writeFile(configPath, `${before}\n[agents.broken]\nharness = "not-a-real-harness"\n`);

    const page = await (await fetch(`${base}/tasks/new`)).text();
    expect(page).toContain('Could not read this project');
    expect(page).toContain('not-a-real-harness');
    expect(page).toContain('<optgroup label="Built-in agents (lazy.toml unread)">');
    expect(page).not.toContain('<optgroup label="Built-in profiles">');
    expect(page).toContain('value="claude-code"');

    await writeFile(configPath, before);
  });

  test('a create naming an agent profile no lazy.toml defines is refused', async () => {
    const res = await post({
      goal: 'Task on a made-up agent',
      prompt: 'x',
      agent: 'company-tokens-cursor',
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('Unknown agent profile &quot;company-tokens-cursor&quot;');
    expect(body).toContain('Available profiles: claude-code, codex, codex-api, codex-subscription, cursor, pi');
    expect(body).toContain('[agents.company-tokens-cursor] block in lazy.toml');
  });

  test('POST creates a backlog task and redirects to it', async () => {
    const res = await post({
      goal: 'Web-created task',
      prompt: 'Do the thing from the dashboard.',
      code: 'web-created-task',
      type: 'feature',
      agent: '',
      model: '',
      effort: '',
      parent: '',
    });
    expect(res.status).toBe(303);
    const location = res.headers.get('location') ?? '';
    // The redirect carries the task's CODE — the address bar names the task.
    expect(location).toContain('/tasks/web-created-task');

    const page = await (await fetch(location)).text();
    expect(page).toContain('Web-created task');
    expect(page).toContain('web-created-task');
    // Backlog: the Start verb is offered, so it has not been started.
    expect(page).toContain('/actions/start');
  });

  test('a refused create keeps the typed prompt and shows the daemon error', async () => {
    const taken = await ctx.lazy(['create', '--goal', 'Taken', '--code', 'taken-code']);
    expect(taken.exitCode).toBe(0);

    const res = await post({
      goal: 'Another task',
      prompt: 'A paragraph the human just wrote and must not lose.',
      code: 'taken-code',
      type: 'task',
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('already exists');
    expect(body).toContain('A paragraph the human just wrote and must not lose.');
    expect(body).toContain('Another task');
  });

  test('a parent that looks like a git option is refused', async () => {
    const res = await post({
      goal: 'Should not exist',
      parent: '--output=/tmp/pwned',
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('cannot start with');
    expect(body).toContain('Should not exist');
  });

  test('an unreadable form body is a 400, not an empty-goal refusal', async () => {
    const res = await fetch(`${base}/tasks/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"goal":"not a form"}',
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('could not be read');
    expect(body).not.toContain('goal cannot be empty');
  });

  test('Start now without a prompt is refused before anything is created', async () => {
    const before = await (await fetch(`${base}/api/tasks`)).json() as unknown[];
    const res = await post({
      goal: 'Should not exist',
      prompt: '',
      start_now: '1',
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('prompt is required to start');
    expect(body).toContain('Should not exist');

    const after = await (await fetch(`${base}/api/tasks`)).json() as unknown[];
    expect(after.length).toBe(before.length);
  });

  test('Start now launches the first turn through the daemon start path', async () => {
    await ctx.setClaudeScenario(successScenario({ result: 'done', sessionId: 'create-start' }));
    const res = await post({
      goal: 'Start from the form',
      prompt: 'Do the work.',
      code: 'start-from-form',
      type: 'task',
      start_now: '1',
    });
    expect(res.status).toBe(303);
    const location = res.headers.get('location') ?? '';
    // Redirect by code; the code URL resolves to the same task the UUID does.
    expect(location).toContain('/tasks/start-from-form');

    const createdId = location.split('/tasks/').pop() ?? '';
    const deadline = Date.now() + 30_000;
    let status = '';
    while (Date.now() < deadline) {
      const body = await (await fetch(`${base}/api/tasks/${createdId}`)).json() as {
        task?: { status: string };
      };
      status = body.task?.status ?? '';
      if (status === 'blocked' || status === 'working') break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(['blocked', 'working']).toContain(status);
  });

  test('Start now with the action-dialog header returns a run that settles', async () => {
    await ctx.setClaudeScenario(successScenario({ result: 'done', sessionId: 'create-dialog' }));
    const form = new FormData();
    form.set('goal', 'Dialog start');
    form.set('prompt', 'Do the work from the dialog.');
    form.set('code', 'dialog-start');
    form.set('start_now', '1');
    const res = await fetch(`${base}/tasks/new`, {
      method: 'POST',
      headers: { [ACTION_DIALOG_HEADER]: '1', Accept: 'application/json' },
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(202);
    const started = await res.json() as { runId?: string; taskId?: string; status?: string };
    expect(started.runId).toBeTruthy();
    expect(started.taskId).toBeTruthy();

    const deadline = Date.now() + 90_000;
    let snap: { status?: string; redirect?: string; error?: string } | null = null;
    while (Date.now() < deadline) {
      const poll = await fetch(`${base}/tasks/${started.taskId}/action-runs/${started.runId}`);
      if (poll.status === 404) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      const body = await poll.json() as { status?: string; redirect?: string; error?: string };
      snap = body;
      if (body.status === 'done' || body.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(snap?.status).toBe('done');
    // The run settles on the task's code URL (freshly minted codes are unique).
    expect(snap?.redirect).toContain('/tasks/dialog-start');
  });
});
