/**
 * E2E: promoting a raised item into a backlog task — `lazy raised promote` and
 * the web Decide control: task creation, provenance, promoted state.
 *
 * Was `followup-promote.test.ts`. Promotion works the same for both kinds now,
 * so the cases run over blocking AND non-blocking items rather than over a
 * separate follow-up entity.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, extractTaskId } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
import { findFullTaskId, taskFilePath } from '../helpers/storage';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';

/** Append one open raised item, returning its id. */
function seedRaised(
  ctx: TestContext,
  shortId: string,
  fields: Record<string, unknown>,
): string {
  const path = taskFilePath(ctx.root, shortId, 'raised-items.json');
  const file = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf-8')) as { raised_items: Array<Record<string, unknown>> }
    : { raised_items: [] };
  const id = randomUUID();
  file.raised_items.push({
    id,
    task_id: findFullTaskId(ctx.root, shortId),
    blocking: false,
    status: 'open',
    created_at: Date.now(),
    ...fields,
  });
  writeFileSync(path, JSON.stringify(file, null, 2));
  return id;
}

function seedProposal(
  ctx: TestContext,
  shortId: string,
  proposal: {
    title: string;
    explanation?: string;
    proposed_code?: string;
    proposed_prompt?: string;
  },
): string {
  const content = proposal.explanation
    ? `${proposal.title}\n\n${proposal.explanation}`
    : proposal.title;
  return seedRaised(ctx, shortId, { content, ...proposal });
}

function seedNote(ctx: TestContext, shortId: string, content: string, blocking = false): string {
  return seedRaised(ctx, shortId, { content, blocking });
}

describe('lazy raised promote', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('creates backlog task with provenance and marks the item promoted', async () => {
    const parentId = await createTask(ctx, 'Release hub');
    const childResult = await ctx.lazy(['create', '--goal', 'Child task', '--parent', parentId]);
    expectSuccess(childResult);
    const childId = extractTaskId(childResult.stdout);
    const itemId = seedNote(ctx, childId, 'Extract retry helper into shared module');

    const result = await ctx.lazy([
      'raised', 'promote', childId, itemId.slice(0, 8),
      '--code', 'fix-retry-helper',
      '--goal', 'Shared retry helper',
    ]);
    expectSuccess(result);
    expectOutput(result, 'Created task');
    expectOutput(result, 'fix-retry-helper');

    const listed = await ctx.lazy(['list', '--all']);
    expectSuccess(listed);
    expectOutput(listed, 'fix-retry-helper');
    expectOutput(listed, 'backlog');

    const show = await ctx.lazy(['show', childId]);
    expectSuccess(show);
    expectOutput(show, 'promoted');

    const raised = await ctx.lazy(['raised', '--all']);
    expectSuccess(raised);
    expect(raised.stdout.includes('fix-retry-helper'), 'promoted task code in listing').toBe(true);
  });

  // Promotion is one verb over one entity: a blocking item promotes exactly as
  // a non-blocking one does, and promoting it is one of the four ways to get it
  // off the accept gate.
  test('promotes a BLOCKING item the same way', async () => {
    const taskId = await createTask(ctx, 'Blocking promote');
    const itemId = seedNote(ctx, taskId, 'Should the new flag default on?', true);

    const result = await ctx.lazy([
      'raised', 'promote', taskId, itemId.slice(0, 8),
      '--subtask', '--code', 'decide-flag-default',
    ]);
    expectSuccess(result);
    expectOutput(result, 'Created task');
    expectOutput(result, 'decide-flag-default');

    const listed = await ctx.lazy(['raised', '--all']);
    expectSuccess(listed);
    expectOutput(listed, 'decide-flag-default');
  });

  // The pre-unification spelling still promotes, for one release.
  test('lazy followup promote still works, warning on stderr', async () => {
    const taskId = await createTask(ctx, 'Alias promote');
    const itemId = seedNote(ctx, taskId, 'Promoted through the old spelling');

    const result = await ctx.lazy(['followup', 'promote', taskId, itemId.slice(0, 8)]);
    expectSuccess(result);
    expectOutput(result, 'Created task');
    expect(result.stderr).toContain('lazy raised');
  });

  test('refuses re-promote', async () => {
    const taskId = await createTask(ctx, 'Promote once');
    const itemId = seedNote(ctx, taskId, 'One-time promote note');

    const first = await ctx.lazy(['raised', 'promote', taskId, itemId.slice(0, 8)]);
    expectSuccess(first);

    const second = await ctx.lazy(['raised', 'promote', taskId, itemId.slice(0, 8)]);
    expectFailure(second);
    expect(second.stderr + second.stdout).toMatch(/already promoted|promoted/i);
  });

  test('omitted --goal/--code use proposal defaults when present', async () => {
    const taskId = await createTask(ctx, 'Proposal promote');
    const itemId = seedProposal(ctx, taskId, {
      title: 'Extract retry helper',
      explanation: 'Three call sites duplicate backoff.',
      proposed_code: 'extract-retry-helper',
      proposed_prompt: 'Move retry logic to src/utils/retry.ts.',
    });

    const result = await ctx.lazy(['raised', 'promote', taskId, itemId.slice(0, 8)]);
    expectSuccess(result);
    expectOutput(result, 'extract-retry-helper');
    expectOutput(result, 'Extract retry helper');

    const show = await ctx.lazy(['show', 'extract-retry-helper']);
    expectSuccess(show);
    expectOutput(show, 'src/utils/retry.ts');
    expectOutput(show, 'Promoted from raised item');
  });

  test('omitted --goal/--code use first sentence and a derived kebab-case code', async () => {
    const taskId = await createTask(ctx, 'Defaults promote');
    const itemId = seedNote(
      ctx,
      taskId,
      'Shipped default is still `claude-opus-4-8` (`DEFAULT_CONFIG` in src/config/loader.ts, ' +
        'the `lazy init` template, CLI `--model` examples, public-docs/lazy-toml.md). ' +
        'More detail that must not become the goal.',
    );

    const result = await ctx.lazy(['raised', 'promote', taskId, itemId.slice(0, 8)]);
    expectSuccess(result);
    expectOutput(result, 'Created task');
    expectOutput(result, 'lazy-toml.md).');
    expectOutput(result, '--model');
    expect(result.stdout).toMatch(/shipped-default-is-still/);

    const listed = await ctx.lazy(['list', '--all']);
    expectSuccess(listed);
    expectOutput(listed, 'shipped-default-is-still');
    expectOutput(listed, 'backlog');
  });

  test('rejects reserved lazy- prefix on --code', async () => {
    const taskId = await createTask(ctx, 'Invalid code promote');
    const itemId = seedNote(ctx, taskId, 'Should not get lazy- code');

    const result = await ctx.lazy([
      'raised', 'promote', taskId, itemId.slice(0, 8),
      '--code', 'lazy-bad-code',
    ]);
    expectFailure(result);
    expect(result.stderr + result.stdout).toMatch(/lazy-/i);
  });
});

describe('web raised-item decide', () => {
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

  function seedWebItem(taskId: string, content: string, blocking = false): string {
    const id = randomUUID();
    writeFileSync(taskFilePath(ctx.root, taskId, 'raised-items.json'), JSON.stringify({
      raised_items: [{
        id,
        task_id: findFullTaskId(ctx.root, taskId),
        content,
        blocking,
        status: 'open',
        created_at: Date.now(),
      }],
    }, null, 2));
    return id;
  }

  test('detail page decide form promotes to a backlog task', async () => {
    const taskId = await createTask(ctx, 'Web promote task');
    const itemId = seedWebItem(taskId, 'Promote me from the web UI');

    const detail = await fetch(`${base}/raised/${itemId}`);
    expect(detail.status).toBe(200);
    const detailHtml = await detail.text();
    // The decision IS the page — one control for both kinds.
    expect(detailHtml).toContain('name="raised_action"');
    expect(detailHtml).toMatch(/[Pp]romote/);
    expect(detailHtml).toContain(`/raised/${itemId}/decide`);

    const form = new FormData();
    form.set('raised_action', 'promote_peer');
    form.set('raised_goal', 'Web promoted goal');
    form.set('raised_code', 'web-promoted-task');
    const promote = await fetch(`${base}/raised/${itemId}/decide`, {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    expect(promote.status).toBe(303);

    const listed = await ctx.lazy(['list', '--all']);
    expectSuccess(listed);
    expectOutput(listed, 'web-promoted-task');
    expectOutput(listed, 'backlog');
    expectOutput(listed, 'Web promoted goal');
  });

  test('detail page dismisses with a note and then shows the decision', async () => {
    const taskId = await createTask(ctx, 'Web dismiss task');
    const itemId = seedWebItem(taskId, 'Dismiss me from the web UI');

    const form = new FormData();
    form.set('raised_action', 'dismiss');
    form.set('raised_response', 'Covered by the retry rewrite');
    const decided = await fetch(`${base}/raised/${itemId}/decide`, {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    expect(decided.status).toBe(303);

    const detail = await fetch(`${base}/raised/${itemId}`);
    const detailHtml = await detail.text();
    expect(detailHtml).toContain('Covered by the retry rewrite');
    expect(detailHtml).toMatch(/Dismissed/i);
    // A decided item offers no second decision.
    expect(detailHtml).not.toContain('name="raised_action"');
  });

  // INVARIANT: every verb is offered on every item. Acknowledge and dismiss are
  // the same act — "I saw it and I will take no action" — differing only in
  // valence, which is worth recording; both close a blocking item's gate.
  test('acknowledge is offered on blocking and non-blocking items alike', async () => {
    const taskId = await createTask(ctx, 'Ack offer task');
    const nonBlocking = seedWebItem(taskId, 'An orthogonal proposal');
    const nonBlockingHtml = await (await fetch(`${base}/raised/${nonBlocking}`)).text();
    expect(nonBlockingHtml).toContain('value="acknowledge"');

    const blockingTask = await createTask(ctx, 'Ack blocking task');
    const blocking = seedWebItem(blockingTask, 'A gating scope question', true);
    const blockingHtml = await (await fetch(`${base}/raised/${blocking}`)).text();
    expect(blockingHtml).toContain('name="raised_action"');
    expect(blockingHtml).toContain('value="acknowledge"');
  });

  test('detail page re-renders with the reason when no decision was chosen', async () => {
    const taskId = await createTask(ctx, 'Web undecided task');
    const itemId = seedWebItem(taskId, 'Needs a decision picked');

    const res = await fetch(`${base}/raised/${itemId}/decide`, {
      method: 'POST',
      body: new FormData(),
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Choose a decision');
    // The form is still there to retry with — nothing was lost.
    expect(body).toContain('name="raised_action"');
  });

  test('detail page prefills first-sentence goal and derives code when both fields are empty', async () => {
    const taskId = await createTask(ctx, 'Web default promote');
    const content =
      'Shipped default is still `claude-opus-4-8` (`DEFAULT_CONFIG` in src/config/loader.ts, ' +
      'the `lazy init` template, CLI `--model` examples, public-docs/lazy-toml.md). ' +
      'More detail that must not become the goal.';
    const itemId = seedWebItem(taskId, content);

    const detail = await fetch(`${base}/raised/${itemId}`);
    expect(detail.status).toBe(200);
    const html = await detail.text();
    expect(html).toContain('lazy-toml.md).');
    expect(html).toContain('--model');

    // Decide with promote and no goal/code, so the derivation under test runs.
    const form = new FormData();
    form.set('raised_action', 'promote_peer');
    const promote = await fetch(`${base}/raised/${itemId}/decide`, {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    expect(promote.status).toBe(303);

    const listed = await ctx.lazy(['list', '--all']);
    expectSuccess(listed);
    expectOutput(listed, 'shipped-default-is-still');
    expectOutput(listed, 'backlog');
  });
});
