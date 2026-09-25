import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { findFullTaskId, setTaskStatus, worktreePathFor } from '../helpers/storage';
import { runMcpSession } from '../helpers/mcp-session';
import { ACTION_DIALOG_HEADER } from '../../src/server/action-run';
import { proseAnchorLine } from '../../src/review/prose-anchor';

/**
 * E2E for the review action row: every web text box that offers Ask agent
 * also offers Add comment and Unblock, so a reviewer who finds something can
 * leave a note, or send it and set the agent working, from the box they are
 * already typing in.
 */
describe('review action row: Ask agent / Add comment / Unblock', () => {
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

  async function startBlockedTask(goal: string): Promise<{ taskId: string; fullId: string }> {
    const taskId = await createTask(ctx, goal, 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    const waited = await ctx.lazy(['wait', taskId]);
    if (waited.exitCode !== 0) {
      throw new Error(`wait failed for ${taskId}: ${waited.stderr}\n${waited.stdout}`);
    }
    return { taskId, fullId: findFullTaskId(ctx.root, taskId)! };
  }

  async function threads(fullId: string): Promise<any> {
    return (await fetch(`${base}/api/review/${fullId}/threads`)).json();
  }

  // INVARIANT: Unblock from an inline box delivers the words WITH their anchor
  // in the turn it starts. The box's context (file/line, quote) is the point of
  // typing there instead of the Unblock dialog.
  test('an inline Unblock stores an anchored comment and starts a turn that carries it', async () => {
    const { taskId, fullId } = await startBlockedTask('Inline unblock');
    const res = await fetch(`${base}/tasks/${fullId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: 'src/foo.ts', line: 4, side: 'new',
        content: 'INLINE_UNBLOCK: rename this', intent: 'unblock',
        anchorSnippet: '+line 4',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.unblockError).toBeUndefined();
    expect(body.comment.intent).toBe('comment');

    let prompt = '';
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !prompt) {
      const show = await ctx.lazy(['show', taskId, '--json']);
      const turns = (JSON.parse(show.stdout).turns ?? []) as Array<{ role: string; prompt: string | null }>;
      const hit = turns.find((t) => t.role === 'human' && (t.prompt ?? '').includes('INLINE_UNBLOCK'));
      if (hit) prompt = hit.prompt ?? '';
      else await new Promise((r) => setTimeout(r, 500));
    }
    expect(prompt).toContain('INLINE_UNBLOCK: rename this');
    expect(prompt).toContain('`src/foo.ts` line 4');
  }, 120_000);

  // INVARIANT: a refused Unblock never loses the words. They are saved as a
  // queued comment BEFORE the turn is attempted, and the refusal comes back as
  // an explanation, not as a failed save. CLAUDE.md: never lose human feedback.
  test('an inline Unblock the task cannot take keeps the words as a queued comment', async () => {
    const { taskId, fullId } = await startBlockedTask('Refused unblock');
    setTaskStatus(ctx.root, taskId, 'working');
    const res = await fetch(`${base}/tasks/${fullId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: 'src/foo.ts', line: 2, side: 'new', content: 'KEEP_ME', intent: 'unblock',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.unblockError).toMatch(/working/);
    const t = await threads(fullId);
    expect(t.pendingDelivery).toBe(1);
    const msgs = t.threads.flatMap((th: { messages: any[] }) => th.messages);
    expect(msgs.some((m: any) => m.content === 'KEEP_ME' && m.delivery_state === 'pending_delivery')).toBe(true);
  }, 90_000);

  test('an unknown intent is refused and names the three', async () => {
    const { fullId } = await startBlockedTask('Bad intent');
    const res = await fetch(`${base}/tasks/${fullId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'a.ts', line: 1, side: 'new', content: 'x', intent: 'shout' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("'unblock'");
  }, 90_000);

  // INVARIANT: an action the task cannot take is not offered, and the row
  // says why in VISIBLE text — the page carries the daemon's reason. (Was
  // "disabled with the reason on hover"; the engineer reversed that on
  // 2026-09-23: a disabled control cannot tell anyone why it is off.)
  test('the Ask dialog offers all four actions, gating Unblock with a reason while working', async () => {
    const { taskId, fullId } = await startBlockedTask('Dialog row');
    const blocked = await (await fetch(`${base}/tasks/${fullId}/review`)).text();
    expect(blocked).toMatch(/formaction="\/tasks\/[^"]+\/comments\/add">Add comment<\/button>/);
    expect(blocked).toMatch(/formaction="\/tasks\/[^"]+\/review\/unblock">Unblock<\/button>/);
    expect(blocked).toContain('data-lz-action-dismiss>Cancel</button>');
    expect(blocked).toContain('data-rv-unblock-reason=""');

    setTaskStatus(ctx.root, taskId, 'working');
    const working = await (await fetch(`${base}/tasks/${fullId}/review`)).text();
    expect(working).toMatch(/data-intent="unblock" hidden>Unblock<\/button>/);
    expect(working).toContain('<span class="rv-hint rv-gate-reason">Unblock: Task is working — wait for it to finish before unblocking.</span>');
    expect(working).toContain('data-rv-unblock-reason="Task is working');
    // Add comment is never gated: it starts nothing.
    expect(working).toMatch(/formaction="\/tasks\/[^"]+\/comments\/add">Add comment<\/button>/);
  }, 90_000);

  test("the Ask dialog's Add comment stores a task comment and starts no turn", async () => {
    const { taskId, fullId } = await startBlockedTask('Dialog comment');
    const form = new FormData();
    form.set('content', 'DIALOG_COMMENT: the verify step 2 output is wrong');
    const res = await fetch(`${base}/tasks/${fullId}/comments/add`, {
      method: 'POST', body: form, headers: { [ACTION_DIALOG_HEADER]: '1' },
    });
    expect(res.status).toBe(202);
    expect((await res.json()).runId).toBeTruthy();

    let html = '';
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      html = await (await fetch(`${base}/tasks/${fullId}/comments`)).text();
      if (html.includes('DIALOG_COMMENT')) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(html).toContain('DIALOG_COMMENT');
    const show = JSON.parse((await ctx.lazy(['show', taskId, '--json'])).stdout);
    expect(show.status).toBe('blocked');
  }, 90_000);

  test("the Ask dialog's Unblock posts its textarea as unblock feedback", async () => {
    const { taskId, fullId } = await startBlockedTask('Dialog unblock');
    const form = new FormData();
    form.set('content', 'DIALOG_UNBLOCK: fix step 3');
    const res = await fetch(`${base}/tasks/${fullId}/review/unblock`, {
      method: 'POST', body: form, redirect: 'manual',
    });
    expect(res.status).toBe(303);
    let found = false;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !found) {
      const show = JSON.parse((await ctx.lazy(['show', taskId, '--json'])).stdout);
      found = (show.turns ?? []).some((t: { prompt: string | null }) => (t.prompt ?? '').includes('DIALOG_UNBLOCK'));
      if (!found) await new Promise((r) => setTimeout(r, 500));
    }
    expect(found).toBe(true);
  }, 120_000);

  // INVARIANT (CLAUDE.md: never lose human feedback): an Unblock sent from an
  // ask box delivers THOSE words, so the daemon must leave the reviewer's
  // unsent feedback-box draft alone. It clears only what it delivered.
  test('an Ask-box Unblock leaves the unsent feedback draft in place', async () => {
    const { taskId, fullId } = await startBlockedTask('Draft survives');
    const saved = await fetch(`${base}/tasks/${fullId}/review/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { feedback: 'UNSENT_FEEDBACK: still thinking' } }),
    });
    expect(saved.ok).toBe(true);

    // An inline (line) Unblock, then — once that turn is back — the Ask
    // dialog's Unblock, which posts `content` rather than `message`.
    const inline = await fetch(`${base}/tasks/${fullId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'src/foo.ts', line: 1, side: 'new', content: 'DRAFT_INLINE', intent: 'unblock' }),
    });
    expect((await inline.json()).unblockError).toBeUndefined();
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    const form = new FormData();
    form.set('content', 'DRAFT_DIALOG: fix it');
    const dialog = await fetch(`${base}/tasks/${fullId}/review/unblock`, { method: 'POST', body: form, redirect: 'manual' });
    expect(dialog.status).toBe(303);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    const show = JSON.parse((await ctx.lazy(['show', taskId, '--json'])).stdout);
    const prompts = (show.turns ?? []).map((t: { prompt: string | null }) => t.prompt ?? '').join('\n');
    expect(prompts).toContain('DRAFT_INLINE');
    expect(prompts).toContain('DRAFT_DIALOG');
    const page = await (await fetch(`${base}/tasks/${fullId}/review`)).text();
    expect(page).toContain('UNSENT_FEEDBACK: still thinking');
  }, 180_000);

  // The Verify tab is where this was first missed: its current prose steps are
  // anchorable report prose, so each gets the "+" and the full action row.
  test('current Verify steps are prose anchors on the report', async () => {
    const { taskId } = await startBlockedTask('Verify anchors');
    const worktree = worktreePathFor(ctx.root, taskId);
    const responses = await runMcpSession(ctx.root, taskId, worktree, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [{ kind: 'how_to_verify', body: 'Open the page.\n\n```bash\necho hi\n```' }],
          },
        },
      },
    ], { timeoutMs: 60_000 });
    expect(responses.find((r) => r.id === 2)?.result?.isError).toBeFalsy();
    const html = await (await fetch(`${base}/tasks/${taskId}/verify`)).text();
    expect(html).toContain(
      '<div class="rv-verify-prose turn-content" data-rv-prose="(report)" data-rv-prose-kind="how_to_verify"><p>Open the page.</p>',
    );
    // A command step is askable too: its panel is the anchored block, and its
    // Comment button opens the same row quoting the commands.
    const line = proseAnchorLine('how_to_verify', 'echo hi');
    expect(html).toContain(`class="rv-cmd-panel rv-prose-block" data-rv-present-host data-file="(report)" data-side="new" data-line="${line}"`);
    expect(html).toMatch(/class="rv-cmd-ask" hidden data-rv-present-ask="[^"]+" data-file="\(report\)" data-side="new" data-line="\d+" data-rv-present-quote="echo hi"/);

    // And a comment on that step, sent with Unblock, reaches the next turn
    // carrying the step it was about.
    const res = await fetch(`${base}/tasks/${taskId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: '(report)', line, side: 'new', content: 'STEP_UNBLOCK: prints nothing',
        intent: 'unblock', anchorSnippet: 'echo hi',
      }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).unblockError).toBeUndefined();
  }, 90_000);
});
