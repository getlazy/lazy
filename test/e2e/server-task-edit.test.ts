import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { readTaskJson } from '../helpers/storage';

/**
 * E2E for the web task-edit surface: rewrite a not-yet-started task's goal and
 * prompt from the browser, and get a product-language refusal once an agent has
 * read them.
 *
 * The daemon performs every edit itself (src/daemon/task-edit-service.ts calls
 * the same `editTask` behind `lazy edit` and `lazy_edit`) — the web layer is
 * never a second writer, and prompt versioning comes for free from that.
 */
describe('lazy web task edit', () => {
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

  const post = (taskId: string, fields: Record<string, string>) =>
    fetch(`${base}/tasks/${taskId}/edit`, {
      method: 'POST',
      body: new URLSearchParams(fields),
      redirect: 'manual',
    });

  test('a backlog task’s prompt is rewritten and kept as a new version', async () => {
    const taskId = await createTask(ctx, 'Editable task', 'Original prompt text');
    const fullId = (readTaskJson(ctx.root, taskId) as { id: string }).id;

    const form = await (await fetch(`${base}/tasks/${taskId}/edit`)).text();
    expect(form).toContain('name="prompt"');
    expect(form).toContain('Original prompt text');
    // The task page is the way in. The edit form's action names the task by
    // its URL segment — code when it has one, id otherwise (no code here).
    const detail = await (await fetch(`${base}/tasks/${taskId}`)).text();
    expect(detail).toContain(`href="/tasks/${fullId}/edit"`);

    const res = await post(taskId, {
      goal: 'Editable task, rewritten',
      prompt: '# Rewritten\n\nDo the *other* thing instead.',
      model: '',
      effort: '',
      agent: 'claude-code',
    });
    expect(res.status).toBe(303);

    // The edit went through the daemon, so the new text IS the current prompt…
    const current = await (await fetch(`${base}/tasks/${taskId}/prompts/current`)).text();
    expect(current).toContain('Do the');
    expect(current).toContain('other');
    // …rendered as Markdown, not shown as raw source.
    expect(current).toContain('<h1>Rewritten</h1>');

    // …and the old text is still readable as an earlier version rather than
    // having been silently overwritten.
    const after = await (await fetch(`${base}/tasks/${taskId}`)).text();
    expect(after).toContain('Editable task, rewritten');
    expect(after).toContain('Prompt History');
    const v1 = await (await fetch(`${base}/tasks/${taskId}/prompts/1`)).text();
    expect(v1).toContain('Original prompt text');
  });

  // INVARIANT (CLAUDE.md, "never lose human feedback"): a refused save
  // re-renders from what was TYPED, never from storage. The human's rewritten
  // prompt must survive a validation error on an unrelated field.
  //
  // INVARIANT: and the refusal is total — editTask validates every field before
  // it writes any of them, so "could not be saved" never means "half of it was
  // saved". The prompt below must NOT have become a new version.
  test('a refused save explains itself and keeps the typed prompt', async () => {
    const taskId = await createTask(ctx, 'Refusal task', 'Original prompt text');

    const res = await post(taskId, {
      goal: 'Refusal task',
      prompt: 'A paragraph the human just wrote and must not lose.',
      model: '',
      effort: 'turbo', // not a valid effort level
      agent: 'claude-code',
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('could not be saved');
    expect(body).toContain('A paragraph the human just wrote and must not lose.');

    // Nothing was written.
    const current = await (await fetch(`${base}/tasks/${taskId}/prompts/current`)).text();
    expect(current).toContain('Original prompt text');
  });

  // INVARIANT: the UI derives what is editable from the same predicate the
  // daemon enforces (src/task-edit-rules.ts), so a started task is never shown
  // a prompt box that would then be refused — and the reason is product
  // language naming what IS still changeable, not an RPC error.
  test('a started task’s goal and prompt are locked, with the reason and the alternative', async () => {
    const taskId = await createTask(ctx, 'Started task', 'Original prompt text');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    let page = '';
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      page = await (await fetch(`${base}/tasks/${taskId}/edit`)).text();
      if (page.includes('already run')) break;
      await new Promise((r) => setTimeout(r, 300));
    }

    expect(page).toContain('already run');
    expect(page).toContain('goal and prompt are locked');
    expect(page).toContain('model, effort and agent');
    // No prompt box at all — the refusal is the absence of the field, not an
    // error after the fact.
    expect(page).not.toContain('name="prompt"');
    // What IS editable is still offered.
    expect(page).toContain('name="effort"');
    expect(page).toContain('name="agent"');

    // A hand-posted prompt is DROPPED, not relayed to the daemon and refused:
    // the handler decides what may be sent from the same predicate it rendered
    // from, so a locked field never leaves the web layer. With nothing else
    // changed that leaves an empty edit, which is reported as such (200) rather
    // than as an error — there is nothing wrong with the task, and nothing was
    // written. Posting the form's own values back unchanged is what a browser
    // does, so the model field carries the model the page rendered.
    const model = page.match(/name="model" value="([^"]*)"/)?.[1] ?? '';
    const res = await post(taskId, { prompt: 'sneaked in', model, effort: '', agent: 'claude-code' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Nothing changed');

    const current = await (await fetch(`${base}/tasks/${taskId}/prompts/current`)).text();
    expect(current).toContain('Original prompt text');
    expect(current).not.toContain('sneaked in');
  });

  test('an agent the picker does not offer is kept, in its own group, truthfully', async () => {
    // INVARIANT: the agent picker's groups say where a name CAME FROM, so an
    // option may never sit in a group that misdescribes it. A task's pinned
    // agent that the offered set does not contain is neither configured nor
    // built-in: it gets its own group, at the end, never the position reserved
    // for the project's own profiles.
    const configPath = join(ctx.root, 'lazy.toml');
    const base_ = await readFile(configPath, 'utf-8');
    expect(base_).not.toMatch(/^\s*\[agents\./m);
    await writeFile(configPath, `${base_}\n[agents.work-codex]\nharness = "codex"\nmodel = "gpt-5-codex"\n`);
    const orphaned = await createTask(ctx, 'Pinned to a since-deleted profile', 'x', { agent: 'work-codex' });
    // …and now the human deletes the block the task names.
    await writeFile(configPath, base_);

    const page = await (await fetch(`${base}/tasks/${orphaned}/edit`)).text();
    expect(page).toContain('<optgroup label="Pinned on this task">');
    expect(page).toContain('work-codex — this task names it, but no [agents.&lt;name&gt;] block');
    // Not in the configured group, and not ahead of the real profiles.
    expect(page).not.toContain('Configured profiles (lazy.toml)');
    expect(page.indexOf('Built-in profiles')).toBeLessThan(page.indexOf('Pinned on this task'));
    // Still selectable, so saving the form cannot switch it silently.
    expect(page).toContain('value="work-codex" selected');

    // A pinned agent lazy merely HIDES — its internal QA harness — is a real
    // built-in profile, so it keeps its true summary and is never described as
    // undefined.
    const internal = await createTask(ctx, 'Pinned to the internal agent', 'x', { agent: 'qa-agent' });
    const internalPage = await (await fetch(`${base}/tasks/${internal}/edit`)).text();
    expect(internalPage).toContain('<optgroup label="Pinned on this task">');
    expect(internalPage).toContain('qa-agent — qa-agent');
    expect(internalPage).not.toContain('qa-agent — this task names it');
  });
});
