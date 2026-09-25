/**
 * E2E for a review in progress surviving the tab it was typed in.
 *
 * Unsent feedback, an unsent accept reason and the viewed/collapsed ticks are
 * task state held by the daemon, not tab state: typing, navigating away and
 * coming back — or opening the same review in a second browser — must show the
 * same words. The action that delivers them is what clears them.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { seedFinal } from '../helpers/final';
import { checkDaemonHealth } from '../../src/daemon';
import { DaemonClient } from '../../src/daemon/client';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { reviewDraftKey } from '../../src/review/draft-key';

describe('a review in progress is persisted per task', () => {
  let ctx: TestContext;
  let base: string;
  // The dashboard needs a browser session, so every request below goes through
  // the signed-in fetch this shadows the global one with.
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

  /** Create a task, run one mock turn, and wait until it is blocked for review. */
  async function blockedTask(goal: string): Promise<string> {
    const shortId = await createTask(ctx, goal, 'Do work');
    await ctx.lazyMocked(['start', shortId, '--yes'], MOCK_CLAUDE_SUCCESS);

    let fullId = '';
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && !fullId) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = (queue as { id: string }[]).find((e) => e.id.startsWith(shortId));
      if (hit) fullId = hit.id;
      else await new Promise((r) => setTimeout(r, 400));
    }
    expect(fullId).not.toBe('');
    return fullId;
  }

  async function saveDraft(taskId: string, patch: Record<string, unknown>): Promise<Response> {
    return fetch(`${base}/tasks/${taskId}/review/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch }),
    });
  }

  test('feedback and an accept reason typed but not sent come back on reload', async () => {
    const taskId = await blockedTask('Draft survives reload');

    const saved = await saveDraft(taskId, {
      feedback: 'Half a thought about the parser.',
      acceptReason: 'Looks right after the second read.',
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()).savedAt).toBeGreaterThan(0);

    // A fresh request is what a reload, a second tab and a second browser all
    // are: the daemon holds the draft, so all three see the same words.
    const html = await (await fetch(`${base}/tasks/${taskId}/review`)).text();
    expect(html).toContain('Half a thought about the parser.');
    expect(html).toContain('Looks right after the second read.');

    // And a client that shares nothing with that browser at all — a separate
    // session over RPC — reads the same words back. That is what makes this
    // task state rather than tab state.
    const client = await DaemonClient.create(ctx.root);
    expect(client).not.toBeNull();
    const { draft } = (await client!.rpc('reviewGetDraft', ctx.root, { taskId })) as {
      draft: { feedback: string; accept_reason: string };
    };
    expect(draft.feedback).toBe('Half a thought about the parser.');
    expect(draft.accept_reason).toBe('Looks right after the second read.');
  });

  // The ticks are keyed by CONTENT HASH, so a file that changed under the
  // reviewer comes back unviewed rather than falsely ticked.
  test('viewed ticks are stored per file content hash', async () => {
    const taskId = await blockedTask('Viewed ticks persist');

    const saved = await saveDraft(taskId, { viewedFiles: { 'src/app.ts': 'hash-abc' } });
    expect(saved.status).toBe(200);

    const html = await (await fetch(`${base}/tasks/${taskId}/review`)).text();
    expect(html).toContain('hash-abc');
  });

  // INVARIANT: a tick patch MERGES, and an untick is an empty string. A caller
  // that has not read the draft — which is every Lazy Teams client for the
  // length of one request, because that read rides the member's own actor token
  // — must not be able to destroy ticks it never knew about just by ticking one
  // file. Omission used to mean "untick", which made exactly that happen.
  test('a tick patch merges, and only an empty string takes one back', async () => {
    const taskId = await blockedTask('Ticks merge');

    expect((await saveDraft(taskId, { viewedFiles: { 'a.ts': 'hash-a' } })).status).toBe(200);
    // A second caller that knows nothing about `a.ts`.
    expect((await saveDraft(taskId, { viewedFiles: { 'b.ts': 'hash-b' } })).status).toBe(200);

    let html = await (await fetch(`${base}/tasks/${taskId}/review`)).text();
    expect(html).toContain('hash-a');
    expect(html).toContain('hash-b');

    // Taking one back is still expressible — and takes back only that one.
    expect((await saveDraft(taskId, { viewedFiles: { 'a.ts': '' } })).status).toBe(200);

    html = await (await fetch(`${base}/tasks/${taskId}/review`)).text();
    expect(html).not.toContain('hash-a');
    expect(html).toContain('hash-b');
  });

  test('a malformed draft is refused at the surface, not stored', async () => {
    const taskId = await blockedTask('Draft validation');

    const notAnObject = await fetch(`${base}/tasks/${taskId}/review/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: 'feedback' }),
    });
    expect(notAnObject.status).toBe(400);

    // A viewed tick is a content hash, never a nested object.
    const badTick = await saveDraft(taskId, { viewedFiles: { 'src/app.ts': { seen: true } } });
    expect(badTick.status).toBeGreaterThanOrEqual(400);

    const html = await (await fetch(`${base}/tasks/${taskId}/review`)).text();
    expect(html).not.toContain('"seen"');
  });

  // INVARIANT: a draft goes away when its words have been DELIVERED, and only
  // then. Unblock is that delivery for feedback; a draft left behind would come
  // back in the box as if it had never been sent.
  test('delivering the feedback clears the draft', async () => {
    const taskId = await blockedTask('Draft clears on unblock');

    expect((await saveDraft(taskId, { feedback: 'ship it, but rename the flag' })).status).toBe(200);
    expect(await (await fetch(`${base}/tasks/${taskId}/review`)).text()).toContain(
      'ship it, but rename the flag'
    );

    const form = new FormData();
    form.set('message', 'ship it, but rename the flag');
    const posted = await fetch(`${base}/tasks/${taskId}/review/unblock`, {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    // A redirect, not a re-rendered page: a re-render means the unblock was
    // refused, and a refusal must LEAVE the draft alone.
    expect(posted.status).toBe(303);

    const html = await (await fetch(`${base}/tasks/${taskId}/review`)).text();
    expect(html).not.toContain('ship it, but rename the flag');
  });

  // INVARIANT: clearing a delivered draft is the DAEMON's job, not the review
  // page's. A reviewer who types on the dashboard and then unblocks from a
  // terminal (or an agent calling lazy_unblock) must not get the stale words
  // back in the box — every client of the daemon is equal in front of it.
  test('unblocking from the CLI clears the draft the dashboard wrote', async () => {
    const taskId = await blockedTask('Draft clears on CLI unblock');

    expect((await saveDraft(taskId, { feedback: 'typed in the browser' })).status).toBe(200);
    expect(await (await fetch(`${base}/tasks/${taskId}/review`)).text()).toContain(
      'typed in the browser'
    );

    const unblocked = await ctx.lazyMocked(
      ['unblock', taskId, '-m', 'typed in the browser'],
      MOCK_CLAUDE_SUCCESS
    );
    expect(unblocked.exitCode).toBe(0);

    const html = await (await fetch(`${base}/tasks/${taskId}/review`)).text();
    expect(html).not.toContain('typed in the browser');
  });

  // Two halves of the same rule: a review that ENDED drops its draft, and a
  // review the daemon REFUSED to end keeps every word for the retry.
  test('a refused accept leaves the draft; a successful one clears it', async () => {
    const refusedId = await createTask(ctx, 'Never started', 'Do work');
    expect((await saveDraft(refusedId, { acceptReason: 'reason for a task with no work' })).status)
      .toBe(200);

    // Backlog: no session, nothing merged, so accept refuses — and a refusal
    // must leave the reason exactly where the reviewer typed it.
    const refused = await ctx.lazy(['accept', refusedId, '--yes']);
    expect(refused.exitCode).not.toBe(0);
    expect(await (await fetch(`${base}/tasks/${refusedId}/review`)).text()).toContain(
      'reason for a task with no work'
    );

    const taskId = await blockedTask('Draft clears on CLI accept');
    expect((await saveDraft(taskId, { acceptReason: 'merging this' })).status).toBe(200);

    // Fixture setup, not the subject (see test/helpers/final.ts).
    await seedFinal(ctx, taskId);

    const accepted = await ctx.lazy(['accept', taskId, '--yes']);
    expect(accepted.exitCode).toBe(0);

    const draftClient = await DaemonClient.create(ctx.root);
    const { draft } = (await draftClient!.rpc('reviewGetDraft', ctx.root, {
      taskId,
    })) as { draft: { accept_reason: string } };
    expect(draft.accept_reason).toBe('');
  });

  // The tick expires on a CONTENT-HASH mismatch, and that comparison runs in
  // the browser — so what is asserted here is the pair of inputs it compares:
  // the hash the draft remembers and the hash the page renders for that file
  // now. When they disagree the file comes back unviewed.
  test('a tick whose file changed under the reviewer no longer matches the rendered hash', async () => {
    const taskId = await blockedTask('Stale tick');

    // Files live on Changes; the draft script (and the remembered hash) ships
    // on every tab. The comparison this test names needs both in one document.
    const first = await (await fetch(`${base}/tasks/${taskId}/changes`)).text();
    // A file section carries its path twice — `data-file` for the diff island
    // and `data-viewed-key` for the shared viewable-section island that owns
    // the tick — and the hash the tick is compared against.
    // Attributes BETWEEN the two are tolerated: `data-file-section` was added
    // to this tag by separate work and sits between them, so written strictly
    // this matched nothing and the test failed for a reason that had nothing to
    // do with ticks. The assertion — remembered hash vs rendered hash — is
    // unchanged.
    const match = first.match(
      /data-file="([^"]+)"[^>]*? data-viewed-key="[^"]+" data-content-hash="([^"]+)"/,
    );
    expect(match).not.toBeNull();
    const [, file, currentHash] = match!;

    // A tick left over from a round in which that file had different content.
    const staleHash = `stale-${currentHash}`;
    expect((await saveDraft(taskId, { viewedFiles: { [file]: staleHash } })).status).toBe(200);

    const html = await (await fetch(`${base}/tasks/${taskId}/changes`)).text();
    // Remembered as ticked...
    expect(html).toContain(staleHash);
    // ...against a file the page still renders at its own, different hash, so
    // `remembered === section.dataset.contentHash` is false and the tick drops.
    expect(html).toMatch(
      new RegExp(
        `data-file="${file}"[^>]*? data-viewed-key="${file}" data-content-hash="${currentHash}"`,
      ),
    );
    expect(staleHash).not.toBe(currentHash);
  });

  // The other half of a review in progress: a comment box opened against one
  // line, typed into and not sent. Same record, same rules — written here
  // because this suite is what "a review in progress is persisted per task"
  // means. The wider matrix for these boxes (two tabs, two surfaces on one
  // line, a payload that must not break the page) is in
  // test/e2e/review-line-drafts.test.ts.
  test('a half-typed line comment comes back on the next render, and a cleared one does not', async () => {
    const taskId = await blockedTask('Line draft round trip');
    const anchor = reviewDraftKey({
      surface: 'line',
      file: 'src/app.ts',
      side: 'new',
      line: 42,
      threadId: '',
    });

    expect(
      (await saveDraft(taskId, { lineDrafts: { [anchor]: 'Is this cast load-bearing?' } })).status,
    ).toBe(200);

    // Seeded back into the island, which is what re-opens the box.
    const html = await (await fetch(`${base}/tasks/${taskId}/changes`)).text();
    const seeded = JSON.parse(/var LINE_DRAFTS = (\{.*?\});/.exec(html)![1]);
    expect(seeded[anchor]).toBe('Is this cast load-bearing?');

    // Sending or cancelling the box patches its anchor away — an empty string.
    expect((await saveDraft(taskId, { lineDrafts: { [anchor]: '' } })).status).toBe(200);
    const after = await (await fetch(`${base}/tasks/${taskId}/changes`)).text();
    expect(JSON.parse(/var LINE_DRAFTS = (\{.*?\});/.exec(after)![1])[anchor]).toBeUndefined();
  });
});
