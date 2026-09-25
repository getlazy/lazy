/**
 * E2E for `/tasks/:id/turns/:sequence` — the turn IN ITS CHUNK.
 *
 * WHAT CHANGED AND WHY: a turn used to get a page of its own. That page was
 * well-oriented and still fragmented the review — it showed one turn with the
 * nudge that caused it and the work that followed stripped away, which is
 * exactly why turns are grouped into chunks everywhere else. The URL is
 * unchanged (every other surface names a turn with it, and pasted links must
 * keep working); it now redirects to the chunked Turns tab anchored on that
 * turn, where the navigation island scrolls to it and marks its chunk current.
 *
 * So this suite asserts the contract that survived the move: the URL resolves,
 * an unknown sequence still 404s rather than silently landing on the top of the
 * tab, the turn is really anchored over there, and the surfaces that LINK here
 * still say where the link leads.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';

describe('web turn deep link', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: {
        LAZY_MOCK_SHOULD_COMMIT: '1',
        LAZY_MOCK_CLAUDE_RESPONSE: JSON.stringify({
          result: 'Did the work and wrote it up.',
          session_id: 'mock-sess-turnpage',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      },
    });
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function blocked(taskId: string): Promise<string> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = queue.find((e: { id: string }) => e.id.startsWith(taskId));
      if (hit) return hit.id as string;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`task ${taskId} never reached the review queue`);
  }

  interface Worked {
    id: string;
    /** The sequences this task actually has, ascending. */
    sequences: number[];
    /** The sequence the Summary's report header names. */
    lastAgent: number;
  }

  /**
   * A task worked twice, so there are two chunks. How many SEQUENCES that
   * produces is lazy's business, not this suite's: sequence allocation is free
   * to change, so the turns are read back and every assertion below is
   * expressed against the real list.
   */
  async function workedTwice(goal: string): Promise<Worked> {
    const taskId = await createTask(ctx, goal, 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    const id = await blocked(taskId);
    await ctx.lazyMocked(['unblock', id, '--message', 'second pass please'], MOCK_CLAUDE_SUCCESS);

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const show = await ctx.lazy(['show', taskId, '--json']);
      const turns = (JSON.parse(show.stdout).turns ?? []) as Array<{ sequence: number; role: string }>;
      const agents = turns.filter((t) => t.role === 'agent');
      const sequences = [...new Set(turns.map((t) => t.sequence))].sort((a, b) => a - b);
      if (agents.length >= 2 && sequences.length >= 2) {
        return { id, sequences, lastAgent: agents[agents.length - 1].sequence };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`task ${taskId} never reached a second agent turn`);
  }

  test('a turn URL lands on the Turns tab, anchored on that turn', async () => {
    const { id, sequences } = await workedTwice('Turn deep link');
    for (const seq of sequences) {
      const res = await fetch(`${base}/tasks/${id}/turns/${seq}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toEndWith(`/tasks/${id}/turns#turn-${seq}`);
    }
  }, 180_000);

  // The anchor has to EXIST over there, or the redirect is a scroll to nothing.
  // One id per sequence, even though a human and an agent turn share one.
  test('the Turns tab carries exactly one anchor per turn sequence', async () => {
    const { id, sequences } = await workedTwice('Turn anchors');
    const html = await (await fetch(`${base}/tasks/${id}/turns`)).text();
    for (const seq of sequences) {
      const hits = html.match(new RegExp(`id="turn-${seq}"`, 'g')) ?? [];
      expect(hits.length).toBe(1);
    }
  }, 180_000);

  test('an unknown turn sequence 404s instead of redirecting to the top of the tab', async () => {
    const { id } = await workedTwice('Turn missing sequence');
    const res = await fetch(`${base}/tasks/${id}/turns/99`, { redirect: 'manual' });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Turn 99 not found');
  }, 180_000);

  // THE OTHER HALF OF DISCOVERABILITY: a link whose text is a bare "#2" tells
  // the reader nothing about where it goes. Every surface naming a turn says
  // the destination, and now says the right one — its chunk.
  //
  // INVARIANT: a turn link on the Turns tab ITSELF is an in-page anchor. The
  // absolute form 302s back to this same tab — a full navigation to reach an
  // element already in the document, and a full navigation fires
  // `beforeunload`, which closes every open web shell. Not tearing the page
  // down for an in-document move is why the tab island exists; a self-link
  // must not undo it.
  test('a turn link on the Turns tab is an in-page anchor', async () => {
    const { id, sequences } = await workedTwice('Turn self links');

    const turnsTab = await (await fetch(`${base}/tasks/${id}/turns`)).text();
    for (const seq of sequences) {
      expect(turnsTab).toContain(
        `<a href="#turn-${seq}" title="Go to turn #${seq} in its chunk">Turn #${seq}</a>`,
      );
    }
    // No self-link takes the long way round through the redirect.
    expect(turnsTab).not.toContain(`href="/tasks/${id}/turns/${sequences[0]}"`);
  }, 180_000);

  // …while a surface linking in from ELSEWHERE keeps the absolute form, where
  // the redirect is doing real work: resolving the turn, 404ing an unknown
  // sequence, and landing the reader on the right tab.
  test('Summary links to a turn with the absolute URL, and says where it goes', async () => {
    const { id, lastAgent } = await workedTwice('Turn inbound links');

    const landing = await (await fetch(`${base}/tasks/${id}`)).text();
    expect(landing).toContain(
      `<a href="/tasks/${id}/turns/${lastAgent}" title="Open turn #${lastAgent} in its chunk">Turn #${lastAgent}</a>`,
    );
  }, 180_000);

  // The navigation island still ships on the Turns tab — j/k move between the
  // rv-viewable sections, which are now CHUNKS, so movement is chunk by chunk.
  test('the Turns tab reviews by chunk: one viewable card per chunk', async () => {
    const { id } = await workedTwice('Turn chunk cards');
    const html = await (await fetch(`${base}/tasks/${id}/turns`)).text();

    expect(html).toContain("'.rv-viewable[data-viewed-key]'");
    const chunkCards = html.match(/data-viewed-key="card:chunk:\d+"/g) ?? [];
    expect(chunkCards.length).toBe(2);
    // …and no turn is a section of its own any more.
    expect(html).not.toContain('data-viewed-key="card:turn:');
    // One numbering: the anchor, the viewed key and the heading agree.
    expect(html).toContain('id="chunk-1"');
    expect(html).toContain('data-viewed-key="card:chunk:1"');
    expect(html).toContain('Chunk 1 ·');
  }, 180_000);

  // The turn page carried two things that were INFORMATION rather than the
  // fragmentation it was removed for, and they had to survive the move.
  test('each turn still says where it sits and what ran it', async () => {
    const { id, sequences } = await workedTwice('Turn context on the chunk view');
    const html = await (await fetch(`${base}/tasks/${id}/turns`)).text();

    // "turn N of M" — a pasted turn number has to be locatable.
    expect(html).toContain(`of ${sequences.length})<`);

    // "Ran as" wherever launch is a real question, and nowhere else. Asserted
    // per turn against the real session rather than as a count, because how
    // many turns of each kind a run produces is lazy's business, not this
    // suite's.
    const blocks = [...html.matchAll(/<details class="chunk-turn"[\s\S]*?<\/details>/g)]
      .map((m) => m[0]);
    expect(blocks.length).toBeGreaterThanOrEqual(2);

    let agentRows = 0;
    for (const block of blocks) {
      const head = block.slice(0, block.indexOf('</summary>'));
      const isHumanAsk = head.includes('[human]') || head.includes('[builder]');
      if (isHumanAsk && !head.includes('turn-auto')) {
        // A turn the engineer typed: no row. `agent: unknown` here would
        // assert three things that are inapplicable, not unknown.
        expect(block).not.toContain('turn-ran-as');
      } else {
        expect(block).toContain('Ran as');
        agentRows++;
      }
    }
    expect(agentRows).toBeGreaterThan(0);
    expect(html).toMatch(/agent: (claude-code|unknown)/);
  }, 180_000);
});
