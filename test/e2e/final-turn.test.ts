/**
 * `lazy_final`: the claim it records, and the fact that nothing ever ASKS an
 * agent how its turn ended.
 *
 * Three seams, because the behaviour spans three layers and no single seam
 * reaches all of them:
 *
 *  - the MCP boundary, over a real `lazy-agent mcp` subprocess: what the tool
 *    accepts, what it refuses, and the protocol-dir marker it leaves for the
 *    supervisor;
 *  - the module mock, which stands in for the supervisor: the claim riding home
 *    on the response, landing on the turn that made it, and every surface then
 *    showing it — including after a later work turn cancels it;
 *  - the FAKE BINARY, because the ABSENCE of a supervisor invocation is only
 *    observable there. The module mock replaces `launchSupervisorAsync`
 *    wholesale, so nothing downstream of it is reachable.
 *
 * A FINAL GATES NOTHING. `lazy accept` does not refuse a task without one —
 * the human deciding with the open items in hand is the declaration — and what
 * a final still decides is whether the daemon dispatches a review. These tests
 * assert the claim and its visibility, and two of them assert the absence of
 * refusals: one an earlier draft of the design wrongly proposed, one the
 * retired turn-ending nudge.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { runMcpSession, mcpPayload as payload, mcpText } from '../helpers/mcp-session';
import { findFullTaskId, worktreePathFor, readTaskStatus, readTurns } from '../helpers/storage';
import { successScenario, sessionStartEvent, resultEvent, type ClaudeScenario } from '../helpers/fake-claude';
import { protocolDir as getProtocolDir } from '../../src/protocol';
import { FINAL_MARKER_FILE } from '../../src/protocol/final-marker';
import { PRESENTATION_MARKER_FILE } from '../../src/protocol/presentation-marker';

/** HEAD of a task's worktree, as git reports it. */
function headSha(ctx: TestContext, taskId: string): string {
  const result = ctx.git('-C', worktreePathFor(ctx.root, taskId), 'rev-parse', 'HEAD');
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}

describe('lazy_final at the MCP boundary', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // A daemon, because the handler runs there: it reads the task's raised
    // items and writes the protocol marker host-side.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Start a task so it has a worktree and a session for the tool to act on. */
  async function startedTask(goal: string): Promise<string> {
    const taskId = await createTask(ctx, goal, 'Do the work');
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    return taskId;
  }

  test('records a claim at the current head and leaves the marker for the supervisor', async () => {
    const taskId = await startedTask('Declare done');
    const fullId = findFullTaskId(ctx.root, taskId);

    const responses = await runMcpSession(ctx.root, fullId, worktreePathFor(ctx.root, taskId), [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_final', arguments: { note: 'Docs deliberately untouched.' } } },
    ]);

    const result = payload(responses.find(r => r.id === 2));
    expect(result.sha).toBe(headSha(ctx, taskId));
    expect(result.note).toBe('Docs deliberately untouched.');
    expect(typeof result.declared_at).toBe('string');

    // The marker is how the in-container supervisor learns the turn declared:
    // it cannot read lazy state, so the daemon drops this in the protocol dir.
    const markerPath = join(getProtocolDir(fullId), FINAL_MARKER_FILE);
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
    expect(marker.final.sha).toBe(headSha(ctx, taskId));
    expect(marker.final.note).toBe('Docs deliberately untouched.');
  }, 60_000);

  // INVARIANT (final-turn design §2.1): there is NO presentation refusal, and an
  // earlier draft of the design was wrong to propose one. The presentation is
  // authored by a wrap-up step that only runs once `lazy_final` has SUCCEEDED,
  // so a refusal here could never be satisfied on a first attempt. The
  // enforcement lives in the presentation step itself, where the thing it
  // requires is actually produced. Do not add it back.
  test('is NOT refused for a missing presentation', async () => {
    const taskId = await startedTask('No presentation anywhere');
    const fullId = findFullTaskId(ctx.root, taskId);

    const responses = await runMcpSession(ctx.root, fullId, worktreePathFor(ctx.root, taskId), [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_final', arguments: {} } },
    ]);

    const reply = responses.find(r => r.id === 2);
    expect(reply?.result?.isError).toBeFalsy();
    expect(payload(reply).sha).toBe(headSha(ctx, taskId));
  }, 60_000);

  // INVARIANT (final-turn design §2.1/§13.4): the two DECLARED turn endings are
  // exclusive at the tool boundary, and the refusal NAMES the item — the point
  // is to tell the agent it has already chosen the other ending, not merely to
  // say no.
  test('refuses while a blocking raise is open, naming it', async () => {
    const taskId = await startedTask('Blocked on a question');
    const fullId = findFullTaskId(ctx.root, taskId);

    const responses = await runMcpSession(ctx.root, fullId, worktreePathFor(ctx.root, taskId), [
      { method: 'initialize', id: 1, params: {} },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_raise',
          arguments: { blocking: true, title: 'Should the flag default on?', content: 'I assumed off.' },
        },
      },
      { method: 'tools/call', id: 3, params: { name: 'lazy_final', arguments: {} } },
    ]);

    const raised = payload(responses.find(r => r.id === 2));
    expect(raised.blocking).toBe(true);

    const refusal = responses.find(r => r.id === 3);
    expect(refusal?.result?.isError).toBe(true);
    const text = mcpText(refusal);
    expect(text).toContain('needs-input');
    expect(text).toContain(String(raised.id));
    expect(text).toContain('Should the flag default on?');

    // ...and a blocking raise leaves its own mark, so the supervisor does not
    // then nudge a turn that has already said what it needs.
    const marker = JSON.parse(readFileSync(join(getProtocolDir(fullId), FINAL_MARKER_FILE), 'utf-8'));
    expect(marker.needs_input).toBeTruthy();
    expect(marker.final).toBeUndefined();
  }, 60_000);

  // INVARIANT: declaring a task done is a claim about work you did, in the turn
  // you did it. The builder has no current task, and there is deliberately no
  // surface for declaring somebody else's final.
  test('is refused in builder mode', async () => {
    const responses = await runMcpSession(ctx.root, '', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_final', arguments: {} } },
    ]);
    const reply = responses.find(r => r.id === 2);
    expect(reply?.result?.isError).toBe(true);
    expect(mcpText(reply)).toContain('not available in builder mode');
  }, 60_000);
});

describe('the claim on the turn, and the surfaces that show it', () => {
  let ctx: TestContext;
  /** Existence declares final for the next mocked turn; contents are the note. */
  let finalFlag: string;

  beforeEach(async () => {
    finalFlag = join(process.env.TMPDIR ?? '/tmp', `lazy-final-flag-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    // The claim reaches the store through the supervisor's response, and under
    // withDaemon the agent runs inside the daemon — so the mock's switches have
    // to be in the DAEMON's env, and the per-turn one has to be a file.
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FINAL: finalFlag },
    });
  });

  afterEach(async () => {
    rmSync(finalFlag, { force: true });
    await ctx.cleanup();
  });

  test('an undeclared task says so, a declared one names who, when and at which sha', async () => {
    const taskId = await createTask(ctx, 'Show the final', 'Do the work');

    // Turn 1 declares nothing.
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expectOutput(await ctx.lazy(['show', taskId]), 'not declared');

    // Turn 2 declares.
    writeFileSync(finalFlag, 'Handing over; the migration is reversible.');
    expectSuccess(await ctx.lazy(['unblock', taskId, '--message', 'finish up']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const show = await ctx.lazy(['show', taskId]);
    expectOutput(show, 'declared by agent');
    expectOutput(show, 'Handing over; the migration is reversible.');

    // The claim is on the TURN that made it — the only place a final lives.
    // wrap_up_steps is the audit record (§13.3): the task is human-audience, the
    // turn declared final, so the wrap-up chain ran its present step and the
    // stamp names exactly those that RAN (violations/maintain/react had nothing
    // to do and ran nothing).
    const declaring = readTurns(ctx.root, taskId).filter(t => t.final);
    expect(declaring).toHaveLength(1);
    expect((declaring[0].final as Record<string, unknown>).actor).toBe('agent');
    expect((declaring[0].final as Record<string, unknown>).wrap_up_steps).toEqual(['present']);

    // ...and a script sees the same answer, resolved once, server-side.
    const json = await ctx.lazy(['show', taskId, '--json']);
    expectSuccess(json);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.final.claim.actor).toBe('agent');
    expect(parsed.final.head_moved).toBe(false);
  }, 120_000);

  // INVARIANT (final-turn design §2.3): ONLY an agent work turn that produced
  // commits un-finals. The whole rule lives in `resolveFinalState`; this asserts
  // it end-to-end, through a real turn, so a surface cannot disagree with the
  // resolver about what the human is shown.
  test('a later work turn with commits clears the final', async () => {
    const taskId = await createTask(ctx, 'Un-final me', 'Do the work');

    writeFileSync(finalFlag, '');
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expectOutput(await ctx.lazy(['show', taskId]), 'declared by agent');

    // Back to work: this turn commits and declares nothing.
    rmSync(finalFlag, { force: true });
    expectSuccess(await ctx.lazy(['unblock', taskId, '--message', 'one more thing']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    expectOutput(await ctx.lazy(['show', taskId]), 'not declared');
    // The RECORD is not erased — turns are append-only, and the earlier claim
    // was true about the head it named. Only the ANSWER changed.
    expect(readTurns(ctx.root, taskId).filter(t => t.final)).toHaveLength(1);
  }, 120_000);
});

describe('the handoff fallback (real supervisor, fake claude)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: a turn that lost its tool channel can still say pencils down
  // via the handoff file, and must not be asked again as if it had said nothing.
  test('a turn that writes a final claim to the handoff file ends as final without a nudge', async () => {
    const taskId = await createTask(ctx, 'Handoff final', 'Do the work');
    const worktree = worktreePathFor(ctx.root, taskId);
    const sandboxDir = join(worktree, '.lazy-task-sandbox');
    const handoffPath = join(sandboxDir, 'turn-handoff.jsonl');

    // Script the fake agent to write the handoff claim during its invocation.
    // The scenario replays for EVERY invocation of the turn — work, then the
    // wrap-up's present step — which is what makes that step pass:
    // the executor clears the presentation marker before that invocation (a
    // work-invocation write never stands in for one), so the replayed write is
    // the present invocation's own declaration, written where the daemon-side
    // lazy_report echo leaves it.
    const fullId = findFullTaskId(ctx.root, taskId);
    const customScenario: ClaudeScenario = {
      steps: [
        { kind: 'emit', event: sessionStartEvent('sess-handoff') },
        { kind: 'write-file', path: handoffPath, content: JSON.stringify({ kind: 'final', content: 'Pencils down via handoff.' }) + '\n' },
        { kind: 'write-file', path: join(getProtocolDir(fullId), PRESENTATION_MARKER_FILE), content: JSON.stringify({ version: 1, declared_at: new Date().toISOString() }) },
        {
          kind: 'emit',
          event: resultEvent({ result: 'Pencils down.', sessionId: 'sess-handoff' }),
        },
      ],
    };
    await ctx.setClaudeScenario(customScenario);

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // 1. The final claim must be recorded at the worktree's HEAD.
    const turns = readTurns(ctx.root, taskId);
    const finalTurn = turns.find(t => t.final);
    expect(finalTurn).toBeDefined();
    expect((finalTurn!.final as any).note).toBe('Pencils down via handoff.');
    expect((finalTurn!.final as any).sha).toBe(headSha(ctx, taskId));

    // 2. No nudge turn should have been produced.
    const nudges = turns.filter(t => t.actor === 'supervisor' && String(t.content).includes('Final or Needs-Input?'));
    expect(nudges).toHaveLength(0);
  }, 120_000);
});

describe('the head has since moved (real supervisor, fake claude)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT (final-turn design §2.3): if the head moves after a final
  // declaration (e.g. via a manual commit or a subsequent turn), the
  // declaration is still recorded, but surfaces must warn that it's stale.
  test('lazy show prints "head has since moved" when the claim SHA is not HEAD', async () => {
    // 1. Create task targeting main.
    const taskId = await createTask(ctx, 'Stale final', 'Do the work');
    const worktree = worktreePathFor(ctx.root, taskId);
    const sandboxDir = join(worktree, '.lazy-task-sandbox');
    const handoffPath = join(sandboxDir, 'turn-handoff.jsonl');
    
    // 3. Declare final via fake agent. The declaration write replays on the
    // present invocation too (the executor clears before it — see the handoff
    // test above); without it the wrap-up's present step parks the turn.
    const customScenario: ClaudeScenario = {
      steps: [
        { kind: 'emit', event: sessionStartEvent('sess-stale') },
        { kind: 'write-file', path: handoffPath, content: JSON.stringify({ kind: 'final', content: 'Done.' }) + '\n' },
        { kind: 'write-file', path: join(getProtocolDir(findFullTaskId(ctx.root, taskId)), PRESENTATION_MARKER_FILE), content: JSON.stringify({ version: 1, declared_at: new Date().toISOString() }) },
        {
          kind: 'emit',
          event: resultEvent({ result: 'Done.', sessionId: 'sess-stale' }),
        },
      ],
    };
    await ctx.setClaudeScenario(customScenario);
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const sha1 = headSha(ctx, taskId);

    // 4. Move the head via a sync turn.
    // To ensure sync actually moves the head, we must ensure the parent branch has a new commit.
    // The parent branch here is 'main' (the root).
    const rootWorktree = ctx.root;
    writeFileSync(join(rootWorktree, 'sync-trigger.txt'), 'sync work');
    expectSuccess(await ctx.git('-C', rootWorktree, 'add', 'sync-trigger.txt'));
    expectSuccess(await ctx.git('-C', rootWorktree, 'commit', '-m', 'trigger sync'));

    expectSuccess(await ctx.lazy(['sync', taskId]));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    
    const sha2 = headSha(ctx, taskId);
    expect(sha1).not.toBe(sha2);

    // Now `lazy show` should report that the head has moved.
    const show = await ctx.lazy(['show', taskId]);
    expectOutput(show, 'head has since moved');

    // And JSON should report it explicitly.
    const json = await ctx.lazy(['show', taskId, '--json']);
    expectSuccess(json);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.final.head_moved).toBe(true);
    expect(parsed.final.claim.sha).toBe(sha1);
  }, 120_000);
});

describe('the turn ending is derived, never asked (real supervisor, fake claude)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // A supervisor invocation is what this is about. The module mock replaces
    // `launchSupervisorAsync` itself, so only this seam can see one happen —
    // or, here, see one NOT happen.
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT (this task): NOTHING ASKS THE AGENT how its turn ended. The
  // daemon reads the ending off what the turn did — an open blocking raise is
  // needs-input, a `lazy_final` is reviewable, neither parks `blocked` — so
  // the old "final, or what do you need?" resume is a whole agent invocation
  // spent on a fact already in the store. It is gone, and no replacement may
  // take its place.
  test('a turn that declares nothing is not asked about it', async () => {
    const taskId = await createTask(ctx, 'Silent ending', 'Do the work');
    await ctx.setClaudeScenario(successScenario({
      result: 'I did some things.',
      sessionId: 'fake-sess-silent-end',
    }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const turns = readTurns(ctx.root, taskId);
    // The scripted turn actually RAN — without this the assertions below pass
    // for the wrong reason.
    const work = turns.filter(t => t.role === 'agent' && (t.turn_type ?? 'work') === 'work');
    expect(work.length).toBeGreaterThan(0);
    expect(String(work[work.length - 1]!.content)).toContain('I did some things.');

    // No invocation asked the agent which ending it was.
    const asks = turns.filter(t => t.actor === 'supervisor' && String(t.content).includes('Final or Needs-Input?'));
    expect(asks).toHaveLength(0);

    // INVARIANT: no new status was invented for it either — "blocked is
    // blocked even if nothing was explicitly raised".
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
    // And nobody declared anything: the ending is read, not assumed.
    expectOutput(await ctx.lazy(['show', taskId]), 'not declared');
    expect(turns.find(t => t.final)).toBeUndefined();
  }, 120_000);

  // The needs-input half: a turn that left the marker a refused `lazy_final`
  // (or a blocking `lazy_raise`) writes parks exactly like any other, with no
  // question asked and no claim recorded. The refusal's own half of the chain
  // is pinned in `final-refused.test.ts`.
  test('a turn marked needs-input parks with no question and no claim', async () => {
    const taskId = await createTask(ctx, 'Needs input', 'Do the work');
    const fullId = findFullTaskId(ctx.root, taskId);

    await ctx.setClaudeScenario({
      steps: [
        { kind: 'emit', event: sessionStartEvent('fake-sess-needs-input') },
        {
          kind: 'write-file',
          path: join(getProtocolDir(fullId), FINAL_MARKER_FILE),
          content: JSON.stringify({ version: 1, needs_input: { at: new Date().toISOString() } }),
        },
        { kind: 'emit', event: resultEvent({ result: 'I need a decision first.', sessionId: 'fake-sess-needs-input' }) },
      ],
    });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const turns = readTurns(ctx.root, taskId);
    const work = turns.filter(t => t.role === 'agent' && (t.turn_type ?? 'work') === 'work');
    expect(work.length).toBeGreaterThan(0);
    expect(String(work[work.length - 1]!.content)).toContain('I need a decision first.');

    const asks = turns.filter(t => t.actor === 'supervisor' && String(t.content).includes('Final or Needs-Input?'));
    expect(asks).toHaveLength(0);
    // Needs-input is the other ending, not a claim.
    expect(turns.find(t => t.final)).toBeUndefined();
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

    // INVARIANT (this task): a NEEDS-INPUT park still gets the walkthrough.
    // This is the shape the whole change is about — the human is being asked
    // for a decision, and the walkthrough is what they decide from. Under the
    // old rule the agent could not declare final while its own blocking raise
    // stood, so this was exactly the park that got nothing.
    const presented = turns.filter(
      t => t.actor === 'supervisor' && String(t.content).includes('## Presentation Walkthrough'),
    );
    expect(presented).toHaveLength(1);
  }, 120_000);
});
