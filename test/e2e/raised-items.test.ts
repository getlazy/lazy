/**
 * E2E: structural raised items — accept gate, MCP resolutions, unblock partial
 * resolve, follow-up triage does not block accept.
 *
 * INVARIANT: open raised items refuse accept until every one is responded to,
 * promoted, or dismissed. `--yes` does NOT skip that gate (same philosophy as
 * the protection passphrase). Follow-ups never gate accept. Comments scheduled
 * at resolve land on the next unblock or accept.
 *
 * See docs/design/structural-agent-questions.md and public-docs/raised-items.md.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { findFullTaskId, setTaskStatus, taskFilePath, tasksDirFor, worktreePathFor } from '../helpers/storage';
import { runMcpSession } from '../helpers/mcp-session';
import { seedFinal } from '../helpers/final';

interface SeededRaised {
  id: string;
  content: string;
}

/**
 * Seed an open raised item by writing storage (agents use lazy_raise; tests seed).
 *
 * `blocking` is the whole difference between the two kinds now, so it is a
 * parameter rather than two seeding helpers writing two files.
 */
function seedRaisedItem(
  ctx: TestContext,
  shortId: string,
  content: string,
  blocking = true,
): SeededRaised {
  const path = taskFilePath(ctx.root, shortId, 'raised-items.json');
  const fullId = findFullTaskId(ctx.root, shortId);
  const file = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf-8')) as { raised_items: Array<Record<string, unknown>> }
    : { raised_items: [] };
  const item = {
    id: randomUUID(),
    task_id: fullId,
    content,
    blocking,
    created_at: Date.now(),
    status: 'open',
  };
  file.raised_items.push(item);
  writeFileSync(path, JSON.stringify(file, null, 2));
  return { id: item.id, content };
}

/** Seed an open NON-blocking item — what a follow-up is now. Must NOT gate accept. */
function seedNonBlocking(ctx: TestContext, shortId: string, content: string): SeededRaised {
  return seedRaisedItem(ctx, shortId, content, false);
}

/**
 * Create a task, start it, wait for blocked, commit so accept has something to merge.
 * Same pattern as accept-reason / accept-gates.
 */
async function createStartedTaskWithCommit(
  ctx: TestContext,
  goal: string,
  opts: { final?: boolean } = {},
): Promise<string> {
  const taskId = await createTask(ctx, goal, 'Some work');

  const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  expectSuccess(startResult);

  const waitResult = await ctx.lazy(['wait', taskId]);
  if (waitResult.exitCode !== 0) {
    throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
  }

  const worktreePath = worktreePathFor(ctx.root, taskId);
  writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');
  expect(ctx.git('-C', worktreePath, 'add', 'feature.txt').exitCode).toBe(0);
  expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature').exitCode).toBe(0);

  // Fixture setup, not the subject (see test/helpers/final.ts). Accept does
  // NOT require this — the tests below that pass `final: false` are the ones
  // that say so.
  if (opts.final !== false) seedFinal(ctx, taskId);

  return taskId;
}

describe('raised items accept gate', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // INVARIANT: accept needs the daemon reconciler (see accept-reason.test.ts).
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: --yes does NOT skip raised-item resolution.
  test('accept --yes refuses while a raised item is open', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Refuse open raised');
    const item = seedRaisedItem(ctx, taskId, 'Ship option A or B?');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(result);
    expectError(result, 'raised');
    expectError(result, '--respond-raised');
    expect(result.stderr + result.stdout).toContain(item.id.slice(0, 8));
  }, 60000);

  // INVARIANT (this task): ACCEPT NEEDS NO DECLARATION. A task that parked
  // `blocked` with open blocking items — nobody called `lazy_final`, and while
  // one of those items is open nobody could have — accepts as soon as the
  // items are resolved in the same call. The human resolving them with the
  // work in front of them IS the declaration.
  //
  // This was the shape that made the old gate circular: accept refused for
  // "no final", the remedy was a command whose whole purpose was to produce the
  // presentation the human needed in order to decide whether to accept, and the
  // agent could not declare final while the blocking item stood.
  test('accept succeeds from a plain blocked park with no final at all', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'No final at all', { final: false });
    const item = seedRaisedItem(ctx, taskId, 'Ship option A or B?');

    const result = await ctx.lazy([
      'accept', taskId, '--yes',
      '--respond-raised', `${item.id.slice(0, 8)}=ship A`,
    ]);
    expectSuccess(result);
    expectOutput(result, 'accepted');
    // The refusal that used to stand here named a command that no longer exists.
    expect(result.stderr + result.stdout).not.toContain('lazy finalize');
  }, 60000);

  // INVARIANT (this task): `interrupted` is the one park accept still refuses.
  // A turn that was killed — watchdog, container death, `lazy stop`, a closed
  // pairing — has an UNKNOWN ending: nobody can say whether the branch is
  // judgeable, because the agent never got to stop. Resume or unblock first.
  test('accept still refuses an interrupted task', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Interrupted', { final: false });
    setTaskStatus(ctx.root, taskId, 'interrupted');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(result);
    expectError(result, 'interrupted');
    expectError(result, 'lazy resume');
  }, 60000);

  test('accept succeeds with --respond-raised for every open id', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Respond raised');
    const a = seedRaisedItem(ctx, taskId, 'Question A');
    const b = seedRaisedItem(ctx, taskId, 'Question B');

    const result = await ctx.lazy([
      'accept', taskId, '--yes',
      '--respond-raised', `${a.id.slice(0, 8)}=yes A`,
      '--respond-raised', `${b.id.slice(0, 8)}=yes B`,
    ]);
    expectSuccess(result);
    expectOutput(result, 'accepted');

    const comments = readComments(ctx, taskId);
    expect(comments.some(c => String(c.content).includes('Question A'))).toBe(true);
    expect(comments.some(c => String(c.content).includes('Question B'))).toBe(true);
    const raised = readRaisedItems(ctx, taskId);
    expect(raised.every(r => r.comment_delivered_at)).toBe(true);
  }, 60000);

  // INVARIANT: accept gates on the BLOCKING set only, but a reviewer already
  // resolving that set may acknowledge an open NON-blocking item in the same
  // call — the verb has to reach storage through the resolution flags, not only
  // through `lazy raised acknowledge`.
  test('accept acknowledges a non-blocking item alongside a blocking respond', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Acknowledge non-blocking');
    const gate = seedRaisedItem(ctx, taskId, 'Ship option A or B?');
    const note = seedNonBlocking(ctx, taskId, 'retry path swallows errors');

    const result = await ctx.lazy([
      'accept', taskId, '--yes',
      '--respond-raised', `${gate.id.slice(0, 8)}=ship A`,
      '--acknowledge-raised', note.id.slice(0, 8),
    ]);
    expectSuccess(result);
    expectOutput(result, 'accepted');

    const raised = readRaisedItems(ctx, taskId);
    expect(raised.find(r => r.id === gate.id)?.status).toBe('responded');
    expect(raised.find(r => r.id === note.id)?.status).toBe('acknowledged');
  }, 60000);

  // INVARIANT: acknowledge closes a BLOCKING item's gate exactly as dismiss
  // does. The two are the same act — "I saw it and I will take no action" —
  // and differ only in valence ("maybe later" vs "will not act"), which is
  // recorded but is not a rule a reviewer has to learn.
  test('accept succeeds when a blocking item is acknowledged', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Acknowledge blocking');
    const gate = seedRaisedItem(ctx, taskId, 'Ship option A or B?');

    const result = await ctx.lazy([
      'accept', taskId, '--yes',
      '--acknowledge-raised', `${gate.id.slice(0, 8)}=maybe later`,
    ]);
    expectSuccess(result);
    expectOutput(result, 'accepted');

    const raised = readRaisedItems(ctx, taskId);
    expect(raised.find(r => r.id === gate.id)?.status).toBe('acknowledged');
  }, 60000);

  test('accept succeeds with --promote-raised-subtask and --dismiss-raised', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Promote and dismiss');
    const promote = seedRaisedItem(ctx, taskId, 'Which API?');
    const dismiss = seedRaisedItem(ctx, taskId, 'Tighten later?');

    const result = await ctx.lazy([
      'accept', taskId, '--yes',
      '--promote-raised-subtask', promote.id.slice(0, 8),
      '--dismiss-raised', `${dismiss.id.slice(0, 8)}=out of scope`,
    ]);
    expectSuccess(result);
    expectOutput(result, 'accepted');
  }, 60000);

  // INVARIANT: promote_subtask is STRUCTURAL — lazy creates the child task
  // itself, exactly like promote_peer. It originally shipped as a pending
  // COMMENT only ("promote this into its own subtask and work it there"), which
  // is a no-op on this very path: the comment lands on a task that is
  // completing, no further turn ever runs, and the subtask never exists.
  //
  // The child is created before the merge; accept's later reparent step re-reads
  // children from storage, so it lands on the accepted task's target (here, the
  // top-level task's branch) rather than on a merged task branch.
  test('accept --promote-raised-subtask creates a real child task, re-parented to the accept target', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Promote subtask at accept');
    const item = seedRaisedItem(ctx, taskId, 'Handle the empty-input case too');

    const result = await ctx.lazy([
      'accept', taskId, '--yes',
      '--promote-raised-subtask', `${item.id.slice(0, 8)}=worth doing next`,
    ]);
    expectSuccess(result);
    expectOutput(result, 'accepted');

    const raised = readRaisedItems(ctx, taskId);
    const stored = raised.find(r => r.id === item.id);
    expect(stored?.status).toBe('promoted_subtask');
    expect(stored?.promoted_task_id).toBeTruthy();
    expect(stored?.comment_delivered_at).toBeTruthy();

    const child = findTaskByGoal(ctx, 'Handle the empty-input case');
    expect(child).toBeTruthy();
    expect(child!.id).toBe(stored!.promoted_task_id);

    // Re-parented off the accepted task onto its target branch. (The accepted
    // task was top-level, so its children inherit the branch it merged into.)
    expect(child!.target?.kind).toBe('branch');
    expect(child!.target?.branch).toBeTruthy();

    // Prompt carries the raised item, the reviewer note, and provenance.
    const prompt = String(child!.prompt ?? '');
    expect(prompt).toContain('Handle the empty-input case too');
    expect(prompt).toContain('worth doing next');
    expect(prompt).toContain('Promoted from raised item');

    // Comment is informational and names the created task — never an
    // instruction to the agent to create it.
    const comments = readComments(ctx, taskId);
    const delivered = comments.filter(c => String(c.content).includes('promoted to a subtask'));
    expect(delivered.length).toBeGreaterThan(0);
    expect(comments.some(c => String(c.content).includes('Promote this into its own subtask'))).toBe(false);
  }, 90000);

  // Same invariant on the unblock path, where the child stays UNDER the
  // originating task (nothing was accepted, so nothing is re-parented).
  test('unblock --promote-raised-subtask creates a child under the originating task', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Promote subtask at unblock');
    const item = seedRaisedItem(ctx, taskId, 'Split the retry path out');

    const unblock = await ctx.lazyMocked(
      [
        'unblock', taskId,
        '--message', 'Promoting that one',
        '--promote-raised-subtask', item.id.slice(0, 8),
        '--yes',
      ],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(unblock);

    const raised = readRaisedItems(ctx, taskId);
    const stored = raised.find(r => r.id === item.id);
    expect(stored?.status).toBe('promoted_subtask');
    expect(stored?.comment_delivered_at).toBeTruthy();

    const child = findTaskByGoal(ctx, 'Split the retry path out');
    expect(child).toBeTruthy();
    expect(child!.id).toBe(stored!.promoted_task_id);
    expect(child!.target?.kind).toBe('task');
    expect(child!.target?.parentTaskId).toBe(findFullTaskId(ctx.root, taskId));

    // Inherits the originating task's agent — a promotion continues the same
    // work and must not silently land on the project default.
    const parentTask = JSON.parse(
      readFileSync(taskFilePath(ctx.root, taskId, 'task.json'), 'utf-8'),
    ) as Record<string, any>;
    expect(child!.agent_id).toBe(parentTask.agent_id);

    const comments = readComments(ctx, taskId);
    expect(comments.some(c => String(c.content).includes('promoted to a subtask'))).toBe(true);
  }, 90000);

  // INVARIANT: follow-ups never gate accept.
  // INVARIANT: only BLOCKING items gate. A non-blocking item is today's
  // follow-up and must never hold up an accept, triaged or not.
  test('untriaged non-blocking item does NOT block accept', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Follow-up non-blocking');
    seedNonBlocking(ctx, taskId, 'Orthogonal: fix flaky helper');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'accepted');
  }, 60000);

  test('lazy raised acknowledge records triage without affecting accept', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Followup triage then accept');
    const item = seedNonBlocking(ctx, taskId, 'Maybe extract shared helper');

    const triage = await ctx.lazy([
      'raised', 'acknowledge', taskId, item.id.slice(0, 8),
      '--note', 'tracked in backlog',
    ]);
    expectSuccess(triage);
    expectOutput(triage, 'Acknowledged');

    // WHO decided is part of the record: `lazy show --full` names the decider
    // for every decided item. On a laptop that is the git identity the daemon
    // resolved (git-identity-single-person stamps it on the decision, which
    // gates an accept and is the one a reviewer most needs a name on); through
    // a per-user token it is that token's person. It read `human` — the bare
    // role — only while nothing could name the human.
    const shown = await ctx.lazy(['show', taskId, '--full']);
    expectSuccess(shown);
    expectOutput(shown, 'decided by: Lazy Test <test@lazy.test>');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
  }, 60000);

  // The pre-unification command name keeps working for one release, and the
  // deprecation line goes to STDERR so a script piping stdout still parses.
  test('lazy followup acknowledge still works, warning on stderr', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Legacy followup alias');
    const item = seedNonBlocking(ctx, taskId, 'Alias still routes here');

    const triage = await ctx.lazy([
      'followup', 'acknowledge', taskId, item.id.slice(0, 8),
    ]);
    expectSuccess(triage);
    expectOutput(triage, 'Acknowledged');
    expect(triage.stderr).toContain('lazy raised');
    expect(triage.stdout).not.toContain('one more release');
  }, 60000);

  // INVARIANT: a reviewer may correct the agent's flag, and promoting an item
  // to blocking makes accept wait for a decision the agent under-weighted.
  test('lazy raised blocking re-flags an item and moves it on or off the gate', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Re-flag a raised item');
    const item = seedNonBlocking(ctx, taskId, 'Actually needs a decision');

    const promote = await ctx.lazy(['raised', 'blocking', taskId, item.id.slice(0, 8), 'true']);
    expectSuccess(promote);

    const refused = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(refused);
    expect(refused.stderr + refused.stdout).toContain(item.id.slice(0, 8));

    const demote = await ctx.lazy(['raised', 'blocking', taskId, item.id.slice(0, 8), 'false']);
    expectSuccess(demote);

    expectSuccess(await ctx.lazy(['accept', taskId, '--yes']));
  }, 90000);

  test('unblock may partially resolve; accept still refuses until complete', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Partial unblock resolve');
    const keep = seedRaisedItem(ctx, taskId, 'Still open after unblock');
    const resolve = seedRaisedItem(ctx, taskId, 'Answered in feedback');

    const unblock = await ctx.lazyMocked(
      [
        'unblock', taskId,
        '--message', 'Going with option 2 for the second question',
        '--respond-raised', `${resolve.id.slice(0, 8)}=option 2`,
        '--yes',
      ],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(unblock);

    const waitResult = await ctx.lazy(['wait', taskId]);
    if (waitResult.exitCode !== 0) {
      throw new Error(`wait after unblock failed: ${waitResult.stderr}\n${waitResult.stdout}`);
    }

    // Still one open — accept must refuse.
    const refused = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(refused);
    expectError(refused, '--respond-raised');
    expect(refused.stderr + refused.stdout).toContain(keep.id.slice(0, 8));

    // Resolve the remainder.
    const accepted = await ctx.lazy([
      'accept', taskId, '--yes',
      '--respond-raised', `${keep.id.slice(0, 8)}=ok keep`,
    ]);
    expectSuccess(accepted);
  }, 90000);

  test('MCP lazy_accept refuses without raised_resolutions; succeeds with a complete set', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'MCP raised resolutions');
    const item = seedRaisedItem(ctx, taskId, 'MCP: pick A or B?');
    const worktree = worktreePathFor(ctx.root, taskId);

    // Builder-style session (empty task id) — lazy_accept is builder/human.
    const refused = await runMcpSession(ctx.root, '', ctx.root, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_accept',
          arguments: { task_id: taskId, reason: 'Looks good' },
        },
      },
    ], { timeoutMs: 60_000 });

    const refuseBody = JSON.stringify(refused.find(r => r.id === 2));
    expect(refuseBody).toMatch(/raised|respond-raised|open-raised/i);

    const accepted = await runMcpSession(ctx.root, '', ctx.root, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_accept',
          arguments: {
            task_id: taskId,
            reason: 'Answered raised item',
            raised_resolutions: [
              { id: item.id.slice(0, 8), action: 'respond', response: 'use A' },
            ],
          },
        },
      },
    ], { timeoutMs: 60_000 });

    const acceptResp = accepted.find(r => r.id === 2);
    expect(acceptResp?.result?.isError).not.toBe(true);
    const text = acceptResp?.result?.content?.map(c => c.text).join('') ?? JSON.stringify(acceptResp);
    expect(text.toLowerCase()).toMatch(/accept/);
  }, 120000);

  // INVARIANT: `blocking` is REQUIRED on lazy_raise. "The agent never decided"
  // is not a default a reviewer can read, so an absent flag is refused rather
  // than silently filed as one kind or the other.
  test('MCP lazy_raise refuses an absent blocking flag, records with one', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'MCP lazy_raise');
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
          name: 'lazy_raise',
          arguments: { content: 'No flag supplied, so this must be refused' },
        },
      },
      {
        method: 'tools/call',
        id: 3,
        params: {
          name: 'lazy_raise',
          arguments: {
            content: 'Should we ship the experimental flag?',
            blocking: true,
            options: ['yes', 'no'],
          },
        },
      },
      {
        // The other flavour of the SAME tool: an orthogonal proposal, filed
        // non-blocking, with only a title.
        method: 'tools/call',
        id: 4,
        params: {
          name: 'lazy_raise',
          arguments: { blocking: false, title: 'The importer has no timeout' },
        },
      },
      {
        method: 'tools/call',
        id: 5,
        params: {
          name: 'lazy_show',
          arguments: { task_id: taskId },
        },
      },
    ], { timeoutMs: 60_000 });

    const textOf = (id: number): string =>
      responses.find(r => r.id === id)?.result?.content?.map(c => c.text).join('') ?? '';

    // INVARIANT: `blocking` has no default — an omitted flag is refused, never
    // guessed. The refusal may arrive on either channel: the tool schema marks
    // it required (JSON-RPC -32602) and the handler re-checks it (isError), and
    // the test pins the REFUSAL, not which of the two layers caught it.
    const missingFlag = responses.find(r => r.id === 2);
    const refusalText = `${textOf(2)}${JSON.stringify(missingFlag?.error ?? {})}`;
    expect(missingFlag?.result?.isError === true || missingFlag?.error !== undefined).toBe(true);
    expect(refusalText).toContain('blocking');

    expect(responses.find(r => r.id === 3)?.result?.isError).not.toBe(true);
    expect(textOf(3)).toContain('experimental flag');

    expect(responses.find(r => r.id === 4)?.result?.isError).not.toBe(true);

    const showText = textOf(5) || JSON.stringify(responses.find(r => r.id === 5));
    expect(showText).toContain('raised_items');
    expect(showText).toContain('experimental flag');
    expect(showText).toContain('importer has no timeout');
    // One array, both kinds, and the old key is gone.
    expect(showText).not.toContain('follow_ups');

    // The second call filed a NON-blocking item, so it must not gate the accept
    // the blocking one does.
    const items = JSON.parse(
      readFileSync(taskFilePath(ctx.root, taskId, 'raised-items.json'), 'utf-8'),
    ) as { raised_items: Array<{ content: string; blocking: boolean }> };
    const nonBlocking = items.raised_items.find(i => i.content.includes('importer has no timeout'));
    expect(nonBlocking?.blocking).toBe(false);
    const raised = items.raised_items.find(i => i.content.includes('experimental flag'));
    expect(raised?.blocking).toBe(true);
  }, 90000);

  test('unblock materializes the pending raised-item comment', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Materialize comment');
    const item = seedRaisedItem(ctx, taskId, 'Ship option A or B?');

    const commentsBefore = readComments(ctx, taskId);
    expect(commentsBefore.filter(c => String(c.content).includes('Ship option A'))).toHaveLength(0);

    const unblock = await ctx.lazyMocked(
      [
        'unblock', taskId,
        '--message', 'Going with A',
        '--respond-raised', `${item.id.slice(0, 8)}=use A`,
        '--yes',
      ],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(unblock);

    const comments = readComments(ctx, taskId);
    const delivered = comments.filter(c => String(c.content).includes('Ship option A'));
    expect(delivered.length).toBeGreaterThan(0);
    expect(String(delivered[0]!.content)).toContain('use A');

    const raised = readRaisedItems(ctx, taskId);
    const stored = raised.find(r => r.id === item.id);
    expect(stored?.status).toBe('responded');
    expect(stored?.comment_delivered_at).toBeTruthy();
  }, 90000);

  test('unblock --promote-raised-peer creates a sibling task and a comment', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Promote peer');
    const item = seedRaisedItem(ctx, taskId, 'Track this as its own task please');

    const unblock = await ctx.lazyMocked(
      [
        'unblock', taskId,
        '--message', 'Promoting the raised item',
        '--promote-raised-peer', item.id.slice(0, 8),
        '--yes',
      ],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(unblock);

    const list = await ctx.lazy(['list', '--all']);
    expectSuccess(list);
    expectOutput(list, 'Track this as its own task');

    const raised = readRaisedItems(ctx, taskId);
    const stored = raised.find(r => r.id === item.id);
    expect(stored?.status).toBe('promoted_peer');
    expect(stored?.promoted_task_id).toBeTruthy();
    expect(stored?.comment_delivered_at).toBeTruthy();

    const comments = readComments(ctx, taskId);
    expect(comments.some(c => String(c.content).includes('peer task'))).toBe(true);
  }, 90000);

  // INVARIANT: stored acknowledge/answer records remain display-only and do
  // not keep the accept gate closed.
  test('legacy acknowledged raised items do not block accept', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Legacy acknowledged');
    const item = seedRaisedItem(ctx, taskId, 'Already decided last week');
    const path = taskFilePath(ctx.root, taskId, 'raised-items.json');
    const file = JSON.parse(readFileSync(path, 'utf-8')) as { raised_items: Array<Record<string, unknown>> };
    const row = file.raised_items.find(r => r.id === item.id);
    expect(row).toBeTruthy();
    row!.status = 'acknowledged';
    row!.resolved_at = Date.now();
    row!.resolved_by = 'human';
    writeFileSync(path, JSON.stringify(file, null, 2));

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'accepted');
  }, 60000);
});

function readComments(ctx: TestContext, shortId: string): Array<Record<string, unknown>> {
  const path = taskFilePath(ctx.root, shortId, 'comments.json');
  if (!existsSync(path)) return [];
  const file = JSON.parse(readFileSync(path, 'utf-8')) as { comments?: Array<Record<string, unknown>> };
  return file.comments ?? [];
}

/** Find a task on disk by a substring of its goal (promoted tasks have no known id). */
function findTaskByGoal(ctx: TestContext, needle: string): Record<string, any> | undefined {
  const dir = tasksDirFor(ctx.root);
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry, 'task.json');
    if (!existsSync(path)) continue;
    const task = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, any>;
    if (typeof task.goal === 'string' && task.goal.includes(needle)) return task;
  }
  return undefined;
}

function readRaisedItems(ctx: TestContext, shortId: string): Array<Record<string, unknown>> {
  const path = taskFilePath(ctx.root, shortId, 'raised-items.json');
  if (!existsSync(path)) return [];
  const file = JSON.parse(readFileSync(path, 'utf-8')) as { raised_items?: Array<Record<string, unknown>> };
  return file.raised_items ?? [];
}
