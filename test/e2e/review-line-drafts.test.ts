/**
 * E2E for the half-typed comment boxes — a line comment, a question about a
 * presented document, a reply being written on a thread.
 *
 * These are the reviewer's unsent words (CLAUDE.md: never lose human feedback),
 * and the whole point of storing them is a ROUND TRIP: what one request writes,
 * the next render of the page has to hand back to the island, and what is
 * deleted has to be gone. That is the half of this feature a test can actually
 * execute — the island's browser behaviour cannot run here — so it is the half
 * that is tested here rather than by looking for helper names in a script.
 *
 * The keys are built with the same `reviewDraftKey` the island's embedded
 * mirror uses (src/review/draft-key.ts), so a drift between the two fails
 * these tests rather than silently hiding a reviewer's words.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { reviewDraftKey } from '../../src/review/draft-key';
import { MAX_LINE_DRAFTS } from '../../src/review-draft';

describe('half-typed comment boxes survive the page', () => {
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

  /** The map the page seeds the island with. */
  async function seededDrafts(taskId: string): Promise<Record<string, string>> {
    const html = await (await fetch(`${base}/tasks/${taskId}/changes`)).text();
    const m = /var LINE_DRAFTS = (\{.*?\});/.exec(html);
    expect(m).not.toBeNull();
    return JSON.parse(m![1]) as Record<string, string>;
  }

  const LINE = reviewDraftKey({
    surface: 'line',
    file: 'src/app.ts',
    side: 'new',
    line: 42,
    threadId: '',
  });
  const PRESENT = reviewDraftKey({
    surface: 'present',
    file: 'src/app.ts',
    side: 'new',
    line: 42,
    threadId: '',
  });

  // The round trip: written, handed back on the next render, and gone when the
  // reviewer sends or cancels it.
  test('a saved box comes back on the next render, and a cleared one does not', async () => {
    const taskId = await blockedTask('Line draft round trip');

    expect((await saveDraft(taskId, { lineDrafts: { [LINE]: 'Is this cast load-bearing?' } })).status)
      .toBe(200);
    expect((await seededDrafts(taskId))[LINE]).toBe('Is this cast load-bearing?');

    // Sending or cancelling a box patches its key away — an empty string.
    expect((await saveDraft(taskId, { lineDrafts: { [LINE]: '' } })).status).toBe(200);
    expect((await seededDrafts(taskId))[LINE]).toBeUndefined();
  });

  // INVARIANT: two tabs cannot erase each other's boxes. Each tab holds the map
  // it was seeded with, so a wholesale write from either would delete every box
  // the other has opened since — which is the loss this whole feature exists to
  // prevent, in a shape that ordinary use (two tabs on one review) reaches.
  test('a second tab does not erase the first tab\'s open boxes', async () => {
    const taskId = await blockedTask('Two tabs');

    await saveDraft(taskId, { lineDrafts: { [LINE]: 'typed in tab A' } });
    // Tab B loaded before that box existed: its patch names only its own key.
    await saveDraft(taskId, { lineDrafts: { [PRESENT]: 'typed in tab B' } });

    const seeded = await seededDrafts(taskId);
    expect(seeded[LINE]).toBe('typed in tab A');
    expect(seeded[PRESENT]).toBe('typed in tab B');

    // And cancelling one of them leaves the other alone.
    await saveDraft(taskId, { lineDrafts: { [LINE]: '' } });
    const after = await seededDrafts(taskId);
    expect(after[LINE]).toBeUndefined();
    expect(after[PRESENT]).toBe('typed in tab B');
  });

  // INVARIANT: the surface is part of the key, so a question about a file's
  // presented document and a comment on the diff row it was rendered from are
  // two boxes with two drafts. Keyed on the anchor alone they shared one, and
  // each keystroke in one overwrote the other.
  test('two boxes on the same line keep separate words', async () => {
    const taskId = await blockedTask('Same anchor, two surfaces');

    await saveDraft(taskId, {
      lineDrafts: { [LINE]: 'about this line', [PRESENT]: 'about the rendered document' },
    });

    const seeded = await seededDrafts(taskId);
    expect(LINE).not.toBe(PRESENT);
    expect(seeded[LINE]).toBe('about this line');
    expect(seeded[PRESENT]).toBe('about the rendered document');
  });

  // INVARIANT: reviewer text is seeded into an inline <script>, so it is
  // escaped for that context. A draft containing a closing script tag — which
  // is what half-typing a comment about this repo's own islands produces —
  // must not end the element early: the remainder would be parsed as HTML and
  // an onerror handler in it would run on the origin holding the dashboard's
  // session cookie.
  test('a draft containing a closing script tag cannot break out of the island', async () => {
    const taskId = await blockedTask('Script tag in a draft');
    const payload = 'why does </script><img src=x onerror="alert(1)"> parse?';

    expect((await saveDraft(taskId, { lineDrafts: { [LINE]: payload } })).status).toBe(200);

    const html = await (await fetch(`${base}/tasks/${taskId}/changes`)).text();
    // The dangerous literal is nowhere in the page — the angle brackets left
    // as unicode escapes, which the HTML parser walks straight past...
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain('\\u003c/script');
    // ...and the value still round-trips intact, escaped rather than mangled.
    expect((await seededDrafts(taskId))[LINE]).toBe(payload);
  });

  // INVARIANT: one field hitting its bound must not take another field's words
  // down with it. The autosave debounce batches everything typed in its window
  // into one patch, so an all-or-nothing refusal silently dropped whatever was
  // in the main feedback box — a feedback-loss path hiding inside a limit the
  // reviewer cannot see. The refused box is named instead of failing mute.
  test('an over-limit comment box is refused on its own, and says so', async () => {
    const taskId = await blockedTask('Draft cap');

    const full: Record<string, string> = {};
    for (let i = 0; i < MAX_LINE_DRAFTS; i++) {
      full[reviewDraftKey({ surface: 'line', file: 'a.ts', side: 'new', line: i + 1, threadId: '' })] =
        'x';
    }
    expect((await saveDraft(taskId, { lineDrafts: full })).status).toBe(200);

    const overflow = reviewDraftKey({
      surface: 'line',
      file: 'a.ts',
      side: 'new',
      line: 99999,
      threadId: '',
    });
    const res = await saveDraft(taskId, {
      feedback: 'the words in the big box',
      lineDrafts: { [overflow]: 'one box too many' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refusedLineDrafts).toEqual([overflow]);
    expect(body.warning).toMatch(/could not be saved/);

    // The rest of the patch IS stored, which is the whole point.
    const html = await (await fetch(`${base}/tasks/${taskId}/review`)).text();
    expect(html).toContain('the words in the big box');
  });

  // The daemon validates this route like every other external surface: a
  // hand-rolled caller cannot park unbounded text on a task.
  test('the route refuses a malformed patch and says what was wrong', async () => {
    const taskId = await blockedTask('Bad patch');
    const res = await saveDraft(taskId, { lineDrafts: { [LINE]: 7 } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/lineDrafts/);
  });
});
