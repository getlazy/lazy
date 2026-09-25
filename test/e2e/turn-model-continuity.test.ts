/**
 * Turn-to-turn continuity of agent / model / effort, on the fake-`claude`-binary
 * seam (the REAL supervisor, a scriptable fake agent).
 *
 * INVARIANT (turn-launch-continuity, fix-turn-model-continuity): every turn a
 * task runs — work turns AND the supervisor's own follow-up invocations
 * (maintained-files nudge, protected-file push-back), sync/merge, pre-accept,
 * ask, auto-resume — launches on the task's CURRENT agent, model and effort,
 * and records them on the turn. Only an explicit override (`--model` /
 * `--effort` / `--agent` on start, unblock or edit) changes them, and it does so
 * by being persisted onto the task, which is where every later launch reads it.
 *
 * WHY THIS SEAM AND NOT THE MODULE MOCK: the maintained-files nudge is a SECOND
 * `claude -p` invocation the supervisor makes itself, after the work turn. The
 * module mock replaces `launchSupervisorAsync` wholesale, so it never runs one —
 * the argv of the nudge invocation is only observable here. That argv is the
 * whole point: the incident this suite pins was a nudge that ran on the
 * project's `[models] default` after the task had been moved to another model,
 * spending the wrong (scarce) quota and throwing away the prompt cache.
 *
 * The two halves are asserted separately on purpose. The argv is what the agent
 * was actually launched with; the recorded turn is what a human reviewing the
 * task later sees. The incident was visible only by accident because the nudge
 * turn happened to carry a label — a launch that is right but unrecorded is a
 * bug that hides the next one.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, fullTaskId } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario, sessionStartEvent, resultEvent } from '../helpers/fake-claude';
import { seedFinal } from '../helpers/final';
import { agentTurns, allTurns, taskDir } from '../helpers/agent-seam';
import { runMcpSession, mcpText } from '../helpers/mcp-session';
import { worktreePathFor } from '../helpers/storage';
import { protocolDir as getProtocolDir } from '../../src/protocol';
import { PRESENTATION_MARKER_FILE } from '../../src/protocol/presentation-marker';

/** The model `lazy init` writes as `[models] default`, and the effort `[agent]` defaults to. */
const PROJECT_DEFAULT_MODEL = 'claude-opus-5';
const PROJECT_DEFAULT_EFFORT = 'medium';

/** What the task is moved to mid-flight. Deliberately neither project default. */
const EDITED_MODEL = 'claude-sonnet-5';
const EDITED_EFFORT = 'high';

/** Effort a reviewer's QUESTION runs at. Not a choice about the task — see the ask test. */
const ASK_ONLY_EFFORT = 'max';

/**
 * Enable one maintained-files group and COMMIT it.
 *
 * The commit is not optional: the daemon resolves a turn's config from the task
 * WORKTREE, which is branched from main, so an uncommitted lazy.toml edit would
 * never reach the supervisor and the nudge would simply never fire — the test
 * would then assert continuity across one invocation and pass for the wrong
 * reason. Appending an `[[automation.maintain]]` array-of-tables entry is safe
 * (unlike re-declaring a `[table]` init already writes, which is a TOML
 * redefinition error).
 */
async function enableMaintain(ctx: TestContext, group: { title: string; pattern: string; instructions: string }): Promise<void> {
  const configPath = join(ctx.root, 'lazy.toml');
  const existing = await readFile(configPath, 'utf-8');
  await writeFile(
    configPath,
    `${existing}\n[[automation.maintain]]\ntitle = "${group.title}"\npattern = "${group.pattern}"\ninstructions = "${group.instructions}"\n`,
  );
  ctx.git('add', 'lazy.toml');
  const commit = ctx.git('commit', '-m', 'Enable maintained files for this test');
  if (commit.exitCode !== 0) {
    throw new Error(`Failed to commit maintained-files config: ${commit.stderr}`);
  }
}

/**
 * Turn the accept-time pre-accept validation turn on.
 *
 * NO commit here, unlike enableMaintain: the accept path loads config from the
 * PROJECT ROOT (`loadConfig(projectRoot)`, no cwd override) and re-reads it per
 * accept, so the uncommitted edit is exactly what the accept sees. `commands`
 * is deliberately non-empty — the gate really runs (a container, a mock gate
 * response); what this suite pins is that even a RUNNING gate launches no agent
 * invocation, so no model is resolved at accept time at all.
 */
async function enablePreAccept(ctx: TestContext): Promise<void> {
  const configPath = join(ctx.root, 'lazy.toml');
  const existing = await readFile(configPath, 'utf-8');
  await writeFile(configPath, `${existing}\n[automation.pre_accept]\nenabled = true\ncommands = ["true"]\ntimeout = 120\n`);
}

/** The task record as storage holds it — the thing every launch resolves from. */
async function readTaskRecord(ctx: TestContext, taskId: string): Promise<{ model?: string; metadata?: Record<string, string> }> {
  const raw = await readFile(join(await taskDir(ctx.root, taskId), 'task.json'), 'utf-8');
  return JSON.parse(raw) as { model?: string; metadata?: Record<string, string> };
}

/** The turn invocations (probes excluded by the fake) the agent binary received. */
async function turnInvocations(ctx: TestContext): Promise<Array<{ argv: string[] }>> {
  return (await ctx.claudeInvocations()).filter(i => {
    if (!i.argv.includes('-p')) return false;
    // The auto-review is a SEPARATE turn the daemon starts once a final
    // settles, and whether its invocation has landed by the time a declared-
    // final turn's assertions run is a race (the shorter the wrap-up, the
    // likelier it has). This suite is about the WORK turn's invocations, so
    // the review's are filtered out rather than tolerated in the count.
    const prompt = String(i.argv[1] ?? '');
    return !prompt.includes('Audience: a reviewer') && !prompt.includes('its verdict could not be read');
  });
}

/** The value of `--<flag>` in an argv, or undefined when the flag is absent. */
function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

describe('turn model/effort continuity (real supervisor, fake claude)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // The incident, end to end. `lazy edit --model/--effort` mid-flight, then an
  // unblock with NO override: both the work invocation and the supervisor's
  // maintained-files nudge invocation must run on the edited values, and both
  // turns must record them.
  test('a maintained-files nudge runs on the task\'s edited model and effort, not the project default', async () => {
    await enableMaintain(ctx, { title: 'docs', pattern: 'docs/**/*', instructions: 'Update affected docs.' });
    const taskId = await createTask(ctx, 'Continuity across turn types', 'Do the work');

    // Turn 1 touches no maintained group — and must never touch one for the
    // rest of the task: the maintained-files check scans the TASK's own range
    // (final-turn design §3.4), so a docs commit here would count as "touched"
    // on every later turn and silence the nudge this test exists to see. The
    // turn is also undeclared, so the wrap-up chain — which now OWNS that check
    // and runs it once, on the declared-final turn — does not run here. What
    // runs is work + the §2.4 final-or-needs-input nudge. This turn exists to
    // establish the BEFORE state (the project defaults) and to put turns on the
    // task, which is what makes the later edit a mid-flight one.
    await ctx.setClaudeScenario({
      sequence: [
        successScenario({
          result: 'First pass done.',
          sessionId: 'fake-sess-continuity-1',
          commit: { message: 'First pass', files: [{ path: 'src/one.ts', content: 'export const one = 1;\n' }] },
        }),
        // The §2.4 nudge's reply: no declaration, so the turn parks. A separate
        // entry rather than a replay, because a replay would re-run turn 1's
        // commit step and the fake's commit throws on an empty commit.
        successScenario({ result: 'First pass done.', sessionId: 'fake-sess-continuity-1' }),
      ],
    });
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // Invocation 0 is the work turn; invocation 1 is the presentation step,
    // which runs on every human-facing park whether or not the turn declared
    // done — this one did not.
    const firstTurn = await turnInvocations(ctx);
    expect(firstTurn.length).toBe(2);
    expect(flagValue(firstTurn[0].argv, '--model')).toBe(PROJECT_DEFAULT_MODEL);
    expect(flagValue(firstTurn[0].argv, '--effort')).toBe(PROJECT_DEFAULT_EFFORT);

    // Clearing also resets the fake's sequence cursor (it counts recorded
    // invocations), so the scenario below is indexed from turn 2's first call.
    await ctx.clearClaudeInvocations();

    // The mid-flight retarget. This is the ONLY place either value is stated.
    expectSuccess(await ctx.lazy(['edit', taskId, '--model', EDITED_MODEL, '--effort', EDITED_EFFORT]));

    // Turn 2 is undeclared too, so again work + the presentation step — the
    // maintained-files check no longer runs per-turn; it is a pencils-down
    // step that waits for the declared-final turn, which turn 3 below is. Both
    // invocations must run on the edited values.
    await ctx.setClaudeScenario({
      sequence: [
        successScenario({
          result: 'Second pass done.',
          sessionId: 'fake-sess-continuity-2',
          commit: { message: 'Second pass', files: [{ path: 'src/two.ts', content: 'export const two = 2;\n' }] },
        }),
        successScenario({
          result: 'Second pass done.',
          sessionId: 'fake-sess-continuity-2',
        }),
      ],
    });
    expectSuccess(await ctx.lazy(['unblock', taskId, '--message', 'Second pass, please']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // Work + the presentation step — the maintained-files check does not run
    // on an undeclared turn. NONE of them may fall back to the project default.
    const secondTurn = await turnInvocations(ctx);
    expect(secondTurn.length).toBe(2);
    for (const invocation of secondTurn) {
      expect(flagValue(invocation.argv, '--model')).toBe(EDITED_MODEL);
      expect(flagValue(invocation.argv, '--effort')).toBe(EDITED_EFFORT);
    }

    await ctx.clearClaudeInvocations();

    // Turn 3 declares final via the handoff file (the fake agent's only channel
    // — it has no MCP tools), so the wrap-up chain runs, on the edited values:
    // work, the maintained-files nudge (the task changed src/one.ts and
    // src/two.ts but never docs/**, so the docs group was skipped), then the
    // presentation step of the human-audience plan. The present
    // invocation declares by writing the marker itself — where the daemon-side
    // lazy_report echo leaves it — because the executor clears the marker
    // before that invocation and refuses to complete without one (§6.2).
    const worktree = worktreePathFor(ctx.root, taskId);
    const handoffPath = join(worktree, '.lazy-task-sandbox', 'turn-handoff.jsonl');
    const fullId = await fullTaskId(ctx, taskId);
    await ctx.setClaudeScenario({
      sequence: [
        {
          steps: [
            { kind: 'emit', event: sessionStartEvent('fake-sess-continuity-3') },
            { kind: 'write-file', path: handoffPath, content: JSON.stringify({ kind: 'final', content: 'Pencils down.' }) + '\n' },
            { kind: 'emit', event: resultEvent({ result: 'Third pass done.', sessionId: 'fake-sess-continuity-3' }) },
          ],
        },
        successScenario({ result: 'Intra-release change; no docs update needed.', sessionId: 'fake-sess-continuity-3' }),
        {
          steps: [
            ...successScenario({ result: 'Authored the walkthrough.', sessionId: 'fake-sess-continuity-3' }).steps!,
            { kind: 'write-file', path: join(getProtocolDir(fullId), PRESENTATION_MARKER_FILE), content: JSON.stringify({ version: 1, declared_at: new Date().toISOString() }) },
          ],
        },
      ],
    });
    expectSuccess(await ctx.lazy(['unblock', taskId, '--message', 'Third pass, please']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // Half one: the argv. Three invocations — work, the maintained-files nudge
    // (this declared-final turn's wrap-up chain), the presentation step — and
    // NONE may fall back to the project default. The auto-review this final
    // dispatches is a DIFFERENT turn; `turnInvocations` filters it out, so the
    // count here is exact rather than a lower bound.
    const thirdTurn = await turnInvocations(ctx);
    expect(thirdTurn.length).toBe(3);
    // Plan order, with the unconfigured steps absent: the maintain nudge, then
    // the presentation step.
    expect(String(thirdTurn[1].argv[1])).toContain('did not touch');
    expect(thirdTurn[2].argv[1]).toContain('presentation.groups');
    for (const invocation of thirdTurn) {
      expect(flagValue(invocation.argv, '--model')).toBe(EDITED_MODEL);
      expect(flagValue(invocation.argv, '--effort')).toBe(EDITED_EFFORT);
    }

    // Half two: the record. Each turn of the exchange carries the labels, so a
    // reviewer can see what it spent without inferring it.
    const all = await allTurns(ctx.root, taskId);
    const agents = all.filter(t => t.role === 'agent');
    // The maintain nudge is the 'nudge' reply that answers the supervisor's
    // "## Maintained Files Review" prompt. Pair by heading rather than by
    // position: the presentation step lands after it, and turns 1
    // and 2 left presentation replies of their own earlier in the transcript.
    const maintainIdx = all.findIndex(
      t => t.role === 'human' && t.actor === 'supervisor' && String(t.content).includes('## Maintained Files Review'),
    );
    expect(maintainIdx).toBeGreaterThanOrEqual(0);
    const nudge = all[maintainIdx + 1];
    expect(nudge).toBeDefined();
    expect(nudge!.model).toBe(EDITED_MODEL);
    expect(nudge!.effort).toBe(EDITED_EFFORT);
    expect(nudge!.agent).toBe('claude-code');

    const work = agents.filter(t => (t.turn_type ?? 'work') === 'work').pop();
    expect(work).toBeDefined();
    expect(work!.model).toBe(EDITED_MODEL);
    expect(work!.effort).toBe(EDITED_EFFORT);
    expect(work!.agent).toBe('claude-code');

    // The request side too: the unblock turn is where a human looks first to
    // see what they launched, and it is written before the agent answers.
    const humanTurns = (await allTurns(ctx.root, taskId)).filter(t => t.role === 'human');
    const request = humanTurns.filter(t => t.actor !== 'supervisor').pop();
    expect(request).toBeDefined();
    expect(request!.model).toBe(EDITED_MODEL);
    expect(request!.effort).toBe(EDITED_EFFORT);

    // ...and the turns in the exchange that must stay UNLABELLED: the nudge
    // PROMPTS the supervisor authored itself. No model produced that text, so
    // labelling them would put a spend in the record where none happened. The
    // adjacent reply turn asserted above is where the nudge's labels live.
    // Every supervised prompt is unlabelled — check the maintain one, this
    // test's subject, by its heading rather than by position.
    const nudgePrompt = humanTurns.find(
      t => t.actor === 'supervisor' && String(t.content).includes('## Maintained Files Review'),
     );
    expect(nudgePrompt).toBeDefined();
    expect(nudgePrompt!.model).toBeUndefined();
    expect(nudgePrompt!.effort).toBeUndefined();
    expect(nudgePrompt!.agent).toBeUndefined();
  }, 180_000);

  // The same rule from the other direction: with nothing edited, turn 2 must run
  // on turn 1's values without the human restating them. This is the "I said
  // opus once" case — served by the persisted `task.model`, not by reading the
  // previous turn's label back (see the turn-labels-are-not-launch-inputs
  // invariant in src/utils/turns.ts).
  test('an override given once at start carries into the next turn without being restated', async () => {
    const taskId = await createTask(ctx, 'Override persistence', 'Do the work');

    await ctx.setClaudeScenario(successScenario({
      result: 'First pass done.',
      sessionId: 'fake-sess-carry-1',
      commit: { message: 'First pass', files: [{ path: 'first.txt', content: 'one\n' }] },
    }));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes', '--model', EDITED_MODEL, '--effort', EDITED_EFFORT]));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    await ctx.clearClaudeInvocations();

    await ctx.setClaudeScenario(successScenario({
      result: 'Second pass done.',
      sessionId: 'fake-sess-carry-2',
    }));
    expectSuccess(await ctx.lazy(['unblock', taskId, '--message', 'Carry on']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // Work, then the final nudge (§2.4). The work invocation is the one this
    // test is about.
    const invocations = await turnInvocations(ctx);
    expect(invocations.length).toBe(2);
    expect(flagValue(invocations[0].argv, '--model')).toBe(EDITED_MODEL);
    expect(flagValue(invocations[0].argv, '--effort')).toBe(EDITED_EFFORT);

    // The last agent turn is now the nudge's reply, so take the last WORK turn:
    // "the model this turn ran under" is a claim about the work, and the nudge
    // inherits the same settings anyway.
    const last = (await agentTurns(ctx.root, taskId))
      .filter(t => (t.turn_type ?? 'work') === 'work').pop();
    expect(last!.model).toBe(EDITED_MODEL);
    expect(last!.effort).toBe(EDITED_EFFORT);
  }, 180_000);

  // The turn type that was actually breaking the rule. A sync's merge turn used
  // to ship `model_id: task.model ?? undefined` raw and NO effort at all — the
  // SyncCommand had no field for one. So conflict resolution ran at whatever
  // effort the agent binary defaults to, and on no model whatsoever when the
  // task had never been given one. It is also the least visible turn type: a
  // clean merge writes only a supervisor announcement, so nothing in the record
  // would have shown the drop.
  //
  // An add/add conflict is what forces the sync to invoke the agent at all.
  test('a sync conflict-resolution turn runs on the task\'s model and effort', async () => {
    const taskId = await createTask(ctx, 'Sync continuity', 'Do the work');

    await ctx.setClaudeScenario(successScenario({
      result: 'Task side written.',
      sessionId: 'fake-sess-sync-1',
      commit: { message: 'Task side', files: [{ path: 'shared.txt', content: 'task version\n' }] },
    }));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes', '--model', EDITED_MODEL, '--effort', EDITED_EFFORT]));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // The same path, added independently on main — an add/add conflict the
    // merge cannot resolve on its own.
    ctx.git('checkout', 'main');
    await writeFile(join(ctx.root, 'shared.txt'), 'main version\n');
    ctx.git('add', 'shared.txt');
    ctx.git('commit', '-m', 'Main side');
    ctx.git('checkout', '-');

    await ctx.clearClaudeInvocations();
    await ctx.setClaudeScenario(successScenario({
      result: 'Conflict resolved.',
      sessionId: 'fake-sess-sync-2',
      commit: { message: 'Resolve conflict', files: [{ path: 'shared.txt', content: 'merged version\n' }] },
    }));

    expectSuccess(await ctx.lazy(['sync', taskId]));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const invocations = await turnInvocations(ctx);
    expect(invocations.length).toBe(1);
    expect(flagValue(invocations[0].argv, '--model')).toBe(EDITED_MODEL);
    expect(flagValue(invocations[0].argv, '--effort')).toBe(EDITED_EFFORT);

    const sync = (await agentTurns(ctx.root, taskId)).filter(t => t.turn_type === 'sync').pop();
    expect(sync).toBeDefined();
    expect(sync!.model).toBe(EDITED_MODEL);
    expect(sync!.effort).toBe(EDITED_EFFORT);
    expect(sync!.agent).toBe('claude-code');
  }, 180_000);

  // Accept-time validation used to be the LAST TURN a task ran — the
  // pre-accept AGENT turn, which spent the task's model and effort at the one
  // moment a human is least likely to be watching (after the reviewer decided).
  // The mechanical gate (final-turn design §5.3) replaced that turn: the
  // configured checks run in their own container with NO agent, so accept
  // resolves no model at all and spends none of the pin — the reason the old
  // turn's model continuity mattered is the reason this suite now pins its
  // absence.
  test('the acceptance gate launches no agent turn — no model is resolved at accept', async () => {
    await enablePreAccept(ctx);
    const taskId = await createTask(ctx, 'Pre-accept continuity', 'Do the work');

    await ctx.setClaudeScenario(successScenario({
      result: 'Work done.',
      sessionId: 'fake-sess-preaccept-1',
      commit: { message: 'The work', files: [{ path: 'feature.txt', content: 'one\n' }] },
    }));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes', '--model', EDITED_MODEL, '--effort', EDITED_EFFORT]));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    // Fixture finality (see test/helpers/final.ts): the gate-only subject here
    // means the wrap-up turn needs the standing scenario's declare-presentation
    // step (what a real agent does via lazy_report).
    await ctx.setClaudeScenario(successScenario({
      result: 'Wrap-up complete.',
      declarePresentation: true,
    }));
    await seedFinal(ctx, taskId);

    await ctx.clearClaudeInvocations();

    expectSuccess(await ctx.lazy(['accept', taskId, '--yes']));

    // The gate ran (the accept merged — its configured check passed), but no
    // agent invocation happened and no pre-accept turn is recorded.
    const invocations = await turnInvocations(ctx);
    expect(invocations.length).toBe(0);
    const preAccept = (await agentTurns(ctx.root, taskId)).filter(t => t.turn_type === 'pre_accept').pop();
    expect(preAccept).toBeUndefined();
  }, 180_000);

  // INVARIANT (turn-launch-continuity): an ask is a ONE-OFF, not an action on
  // the task. Its `--effort` governs that one question and nothing after it, and
  // its agent and model come from the task record — so a reviewer's question
  // rides the prompt cache the work turn just filled instead of opening a second
  // one on `[models] default`.
  //
  // The persistence half is the bug this pins. `launchAskTaskRun` used to resolve
  // through the persisting helper, so an ask's effort was WRITTEN to the task and
  // silently governed every later work turn. The TUI's per-hunk review sends
  // `effort: 'low'` on every question it asks (ASK_EFFORT in
  // src/cli/tui/per-hunk-review.ts) — so reviewing a task pinned to max was
  // enough to demote the rest of its work to low, with nothing in the record
  // saying a human ever chose that.
  //
  // Driven over MCP because `lazy ask` has no `--effort` flag; `lazy_ask` does,
  // and the TUI reaches the same daemon path.
  test('an ask\'s effort applies to that question only and is never written to the task', async () => {
    const taskId = await createTask(ctx, 'Ask one-off', 'Do the work');

    await ctx.setClaudeScenario(successScenario({
      result: 'First pass done.',
      sessionId: 'fake-sess-ask-1',
      commit: { message: 'First pass', files: [{ path: 'work.txt', content: 'one\n' }] },
    }));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes', '--model', EDITED_MODEL, '--effort', EDITED_EFFORT]));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    await ctx.clearClaudeInvocations();
    await ctx.setClaudeScenario(successScenario({
      result: 'Because the parser needed it.',
      sessionId: 'fake-sess-ask-1',
    }));

    // The MCP ownership gate compares the target against the server's own
    // `--task-id` by exact id, so both sides need the full uuid — a short prefix
    // reads as "some other task" and is refused.
    const taskUuid = await fullTaskId(ctx, taskId);
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const responses = await runMcpSession(ctx.root, taskUuid, worktreePath, [
      {
        method: 'initialize',
        id: 1,
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'turn-model-continuity', version: '1.0' },
        },
      },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_ask',
          arguments: { task_id: taskUuid, message: 'Why did you write it that way?', effort: ASK_ONLY_EFFORT },
        },
      },
    ], { timeoutMs: 150_000 });
    const askReply = responses.find(r => r.id === 2);
    expect(askReply?.result?.isError ?? false, `lazy_ask failed: ${mcpText(askReply)}`).toBe(false);
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // The question ran on the task's model at ITS own effort...
    const askInvocations = await turnInvocations(ctx);
    expect(askInvocations.length).toBe(1);
    expect(flagValue(askInvocations[0].argv, '--model')).toBe(EDITED_MODEL);
    expect(flagValue(askInvocations[0].argv, '--effort')).toBe(ASK_ONLY_EFFORT);

    // ...and recorded what it actually ran on, on both sides of the exchange.
    const askTurns = (await allTurns(ctx.root, taskId)).filter(t => t.turn_type === 'ask');
    const askQuestion = askTurns.filter(t => t.role === 'human').pop();
    expect(askQuestion).toBeDefined();
    expect(askQuestion!.model).toBe(EDITED_MODEL);
    expect(askQuestion!.effort).toBe(ASK_ONLY_EFFORT);
    const askAnswer = askTurns.filter(t => t.role === 'agent').pop();
    expect(askAnswer).toBeDefined();
    expect(askAnswer!.model).toBe(EDITED_MODEL);
    expect(askAnswer!.effort).toBe(ASK_ONLY_EFFORT);

    // The task record is untouched: an ask decided nothing about the task.
    const record = await readTaskRecord(ctx, taskId);
    expect(record.model).toBe(EDITED_MODEL);
    expect(record.metadata?.effort).toBe(EDITED_EFFORT);

    // And the proof that matters: the NEXT work turn, with no override of its
    // own, is still on the task's effort — not the question's.
    await ctx.clearClaudeInvocations();
    await ctx.setClaudeScenario(successScenario({
      result: 'Second pass done.',
      sessionId: 'fake-sess-ask-1',
    }));
    expectSuccess(await ctx.lazy(['unblock', taskId, '--message', 'Carry on']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // Work, then the final nudge (§2.4) — invocation 0 is the work turn.
    const workInvocations = await turnInvocations(ctx);
    expect(workInvocations.length).toBe(2);
    expect(flagValue(workInvocations[0].argv, '--model')).toBe(EDITED_MODEL);
    expect(flagValue(workInvocations[0].argv, '--effort')).toBe(EDITED_EFFORT);

    const work = (await agentTurns(ctx.root, taskId)).filter(t => (t.turn_type ?? 'work') === 'work').pop();
    expect(work!.model).toBe(EDITED_MODEL);
    expect(work!.effort).toBe(EDITED_EFFORT);
  }, 240_000);
});
