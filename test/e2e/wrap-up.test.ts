import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'os';
import { writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, disablePreAccept, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import {
  findFullTaskId,
  readSystemMessagesFile,
  readTaskStatus,
  readTurns,
  type StoredTurn,
} from '../helpers/storage';
import { runReconcile } from '../helpers/reconcile';
import { runMcpSession, type JsonRpcResponse } from '../helpers/mcp-session';
import { seedFinal, markAgentLaunched } from '../helpers/final';

/**
 * The wrap-up phase, with audience (docs/design/final-turn.md).
 *
 * Covered here:
 * - The PENCILS-DOWN chain runs once, on the turn that declared final, and not
 *   at all on the turns before it — the mock seam (daemonless): per-invocation
 *   env reaches the mock, so a suite can make turn 1 non-final and turn 2 final
 *   with one flag file.
 * - The PRESENTATION is the exception: it runs on every human-facing park, so
 *   a human asked to decide about a parked task has the walkthrough they are
 *   deciding from. The head-not-moved skip that keeps that affordable is a
 *   supervisor comparison and is pinned at the executor seam
 *   (test/unit/wrap-up-executor-present.test.ts) and the plan that feeds it
 *   (test/unit/wrap-up-plan.test.ts).
 * - "An agent-audience task's wrap-up skips presentation and react (assert the
 *   supervised turns that did NOT happen)" — agent audience is reached the way
 *   production reaches it: an MCP session acting as a task's agent runs
 *   `lazy_create` + `lazy_start`, the only channel that records the launching
 *   actor 'agent' that `audienceOf` resolves.
 * - "At a hub's final the steps run over the whole branch range, so an accepted
 *   child's content is covered there" (§4.2) — the maintained-file nudge fires
 *   at the HUB's final about work an accepted child wrote, after the child's
 *   own (agent-audience) final ran none of the steps.
 *
 * Deliberately NOT covered here:
 * - "The acceptance commands still gate the merge with no agent turn in
 *   between" — that is the pre-accept mechanical run at accept, covered by
 *   test/e2e/pre-accept.test.ts since the agent half was deleted.
 * - Turn-end state is DERIVED and nothing asks the agent about it: there is no
 *   nudge to time, and no suite asserts one.
 */

/** The mock's canned presentation-step result (test/mocks/claude.ts). */
const PRESENT_MARKER = 'Mock agent: authored the report and declared the presentation via lazy_report.';
/** Supervised-step prompt headings (recordSupervisedTurns / supervisedHeading). */
const PRESENT_HEADING = '## Presentation Walkthrough';
const MAINTAIN_HEADING = '## Maintained Files Review';
const REACT_HEADING = '## Reactive Automation';

interface StoredFinalClaim {
  sha: string;
  actor: string;
  note?: string;
  wrap_up_steps: string[];
}

/** The agent reply turns that carry a FinalClaim — the only place a final lives. */
function claimedTurns(turns: StoredTurn[]): Array<StoredTurn & { final: StoredFinalClaim }> {
  return turns.filter(t => t.role === 'agent' && 'final' in t) as Array<StoredTurn & { final: StoredFinalClaim }>;
}

describe('the wrap-up chain runs once, on a final turn (mock seam)', () => {
  let ctx: TestContext;
  /** Existence declares final for the NEXT mocked turn; contents are the note. */
  let finalFlag: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    finalFlag = join(tmpdir(), `lazy-final-flag-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    rmSync(finalFlag, { force: true });
    // ctx.cleanup() removes the external storage dir too (see setup.ts).
    await ctx.cleanup();
  });

  // INVARIANT: the PENCILS-DOWN steps run ONCE, on the turn that declared
  // final, and at no point before it. Before this design they ran after EVERY
  // turn, nagging the agent on ordinary work.
  //
  // INVARIANT (this task): the PRESENTATION is not one of them. It runs on
  // every human-facing park, because it is what the human decides from and
  // they most often decide about a task that parked. Gating it on the
  // declaration gave them the least help at exactly the moment they were being
  // asked to decide.
  test('presents on a park, and runs the pencils-down steps only on the final turn', async () => {
    const taskId = await createTask(ctx, 'Wrap-up timing', 'Implement the feature');

    // Turn 1 — no LAZY_MOCK_FINAL: the mock's wrap-up gate sees no declaration
    // and the turn is an ordinary work turn.
    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(startResult);
    await runReconcile(ctx.root, ctx.protocolBase);

    const turn1 = readTurns(ctx.root, taskId);
    // The walkthrough IS produced: this park is what a human would open.
    expect(turn1.some(t => (t.content as string).includes(PRESENT_MARKER))).toBe(true);
    expect(turn1.some(t => (t.content as string).includes(PRESENT_HEADING))).toBe(true);
    // The pencils-down steps are not.
    expect(turn1.some(t => (t.content as string).includes(MAINTAIN_HEADING))).toBe(false);
    expect(turn1.some(t => (t.content as string).includes(REACT_HEADING))).toBe(false);
    // The work itself happened, and nobody declared anything.
    expect(turn1.some(t => t.role === 'agent')).toBe(true);
    expect(claimedTurns(turn1).length).toBe(0);

    // Turn 2 — the same flag file now exists, so THIS turn declares final.
    writeFileSync(finalFlag, '');
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Ship it', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FINAL: finalFlag } },
    );
    expectSuccess(unblockResult);
    await runReconcile(ctx.root, ctx.protocolBase);

    const turns = readTurns(ctx.root, taskId);
    const claimed = claimedTurns(turns);
    expect(claimed.length).toBe(1);
    const claim = claimed[0]!.final;
    // The claim is the AGENT's (the declaration arrived on a protocol
    // response; the actor is imposed, never read off the wire).
    expect(claim.actor).toBe('agent');
    // The human plan's TRIGGERED subset: push-back, maintain and react are on
    // the plan but detected nothing (no protected patterns, no maintained
    // groups, no reactive rules) — a step that skipped writes no response, so
    // the audited kinds are exactly the steps that ran.
    expect(claim.wrap_up_steps).toEqual(['present']);

    // The presentation ran on BOTH the park and the final — once each, and
    // each preceded by its supervisor-actored prompt turn. (It re-ran on the
    // final because turn 2 committed; the head-not-moved skip is pinned at the
    // executor seam, which is where the comparison lives.)
    const presentReplies = turns.filter(t => t.role === 'agent' && (t.content as string).includes(PRESENT_MARKER));
    expect(presentReplies.length).toBe(2);
    const presentPrompts = turns.filter(
      t => t.role === 'human' && t.actor === 'supervisor' && (t.content as string).includes(PRESENT_HEADING),
    );
    expect(presentPrompts.length).toBe(2);
  });

  // The other side of the gate: a task that never declares final never runs
  // the pencils-down steps, however many turns it takes, and gets no final
  // claim. The mock seam mirrors the real supervisor's gate, so a regression
  // that made the chain unconditional would light this up.
  test('a task that never declares final runs no pencils-down step', async () => {
    const taskId = await createTask(ctx, 'Never final', 'Implement the feature');

    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(startResult);
    await runReconcile(ctx.root, ctx.protocolBase);

    const turns = readTurns(ctx.root, taskId);
    expect(turns.some(t => (t.content as string).includes(MAINTAIN_HEADING))).toBe(false);
    expect(turns.some(t => (t.content as string).includes(REACT_HEADING))).toBe(false);
    expect(claimedTurns(turns).length).toBe(0);
    // But the human still gets the walkthrough for the park.
    expect(turns.some(t => (t.content as string).includes(PRESENT_HEADING))).toBe(true);
    // INVARIANT (this task): "blocked is blocked even if nothing was explicitly
    // raised". No new status was invented for a park with no declaration, and
    // nothing asks the agent which ending it was.
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
  });

  // INVARIANT: the wrap-up files no system message of its own. The systemic
  // check that used to close it — one prompt asking the agent what about the
  // PROJECT got in its way — was removed: it cost a full model turn on the
  // task's context at wrap-up, delayed the accept, and its findings are
  // systemic by definition, so a scheduled sweep over recently accepted tasks
  // finds them just as well. `lazy_message_post` stays as the mid-task channel
  // an agent uses for an infrastructure problem (covered in mcp.test.ts); a
  // final turn on its own must leave the message store EMPTY.
  test('a final turn files no system message of its own', async () => {
    const taskId = await createTask(ctx, 'No systemic step', 'Implement the feature');

    writeFileSync(finalFlag, '');
    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FINAL: finalFlag } },
    );
    expectSuccess(startResult);
    await runReconcile(ctx.root, ctx.protocolBase);

    // The negative is not vacuous: the wrap-up RAN (its present step did).
    const turns = readTurns(ctx.root, taskId);
    expect(turns.some(t => (t.content as string).includes(PRESENT_MARKER))).toBe(true);
    // And no step asked the agent about the project at all.
    expect(claimedTurns(turns)[0]!.final.wrap_up_steps).not.toContain('systemic');

    expect(readSystemMessagesFile(ctx.root)).toEqual([]);
  });
});

describe('the agent-audience wrap-up', () => {
  let ctx: TestContext;
  let finalFlag: string;

  beforeEach(async () => {
    finalFlag = join(tmpdir(), `lazy-final-flag-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    // INVARIANT: the flag path rides the DAEMON env — the withDaemon mock runs
    // inside the daemon process, and per-invocation env never reaches it.
    // Existence of the file means "the running turn declared final", so the
    // suite controls the declaration by creating the file, not by re-enving a
    // long-lived daemon.
    ctx = await setupTestLazy({ withDaemon: true, daemonEnv: { LAZY_MOCK_FINAL: finalFlag } });
  });

  afterEach(async () => {
    rmSync(finalFlag, { force: true });
    await ctx.cleanup();
  });

  // INVARIANT (final-turn design §13.3): audience is derived from the runner,
  // by `audienceOf` and nothing else. A subtask an agent created and started
  // (via the MCP channel, the only writer of the launching actor 'agent') is
  // agent-audience: its wrap-up SKIPS presentation, react and maintain — and
  // with the systemic check removed that leaves nothing, so the final costs
  // the child no supervised invocation at all. Asserted through the supervised
  // turns that did NOT happen, which is the spec's phrasing because an absent
  // step writes no record of its own.
  test('an agent-audience task runs no wrap-up steps', async () => {
    // Parent: created and started by the CLI — a human action — so its launch
    // turn carries actor 'human'. It starts BEFORE the flag file exists, so
    // its own turn declares nothing.
    const parentShortId = await createTask(ctx, 'Agent audience parent', 'Parent work');
    expectSuccess(await ctx.lazyMocked(['start', parentShortId, '--yes'], MOCK_CLAUDE_SUCCESS));
    const waitResult = await ctx.lazy(['wait', parentShortId]);
    expect(waitResult.exitCode).toBe(0);
    const parentFullId = findFullTaskId(ctx.root, parentShortId);
    const parentWorktree = join(ctx.root, '.lazy', 'worktrees', parentShortId);

    const parentTurns = readTurns(ctx.root, parentShortId);
    expect(parentTurns.some(t => 'final' in t)).toBe(false);
    // The parent is HUMAN-audience and parked, so it presented — the contrast
    // the child draws below is that an agent-audience task presents on NEITHER
    // ending, because nobody opens its walkthrough.
    expect(parentTurns.some(t => (t.content as string).includes(PRESENT_MARKER))).toBe(true);

    // The production path to an agent-audience task: an MCP session acting as
    // the parent's agent creates a child and starts it. The creation changelog
    // entry and the child's launch turn both carry the channel actor 'agent',
    // which is exactly what `audienceOf` resolves the plan from.
    writeFileSync(finalFlag, '');
    const responses = await runMcpSession(ctx.root, parentFullId, parentWorktree, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_create', arguments: { goal: 'Agent audience child', prompt: 'Child work' } } },
      {
        method: 'tools/call',
        id: 3,
        params: (prior: JsonRpcResponse[]) => {
          const createReply = prior.find(p => p.id === 2);
          if (!createReply?.result?.content?.[0]) throw new Error('lazy_create produced no reply');
          const created = JSON.parse(createReply.result.content[0].text) as { id: string };
          return { name: 'lazy_start', arguments: { task_id: created.id } };
        },
      },
    ]);

    const createReply = responses.find(r => r.id === 2)!;
    expect(createReply.error).toBeUndefined();
    const created = JSON.parse(createReply.result!.content![0].text) as { id: string; parent_task_id: string };
    expect(created.parent_task_id).toBe(parentShortId);

    const startReply = responses.find(r => r.id === 3)!;
    expect(startReply.error).toBeUndefined();
    expect(JSON.stringify(startReply)).toContain('Started task');

    const waitChild = await ctx.lazy(['wait', created.id]);
    expect(waitChild.exitCode).toBe(0);

    const childTurns = readTurns(ctx.root, created.id);

    // The audience's SOURCE: the child's launch turn was actored by the
    // agent channel, not by a human.
    const launchTurn = childTurns.find(t => t.role === 'human');
    expect(launchTurn).toBeDefined();
    expect(launchTurn!.actor).toBe('agent');

    // The claim: declared, and audited as having run nothing.
    const claimed = claimedTurns(childTurns);
    expect(claimed.length).toBe(1);
    expect(claimed[0]!.final.actor).toBe('agent');
    expect(claimed[0]!.final.wrap_up_steps).toEqual([]);

    // The turns that did NOT happen — no presentation, no react, no maintain:
    // neither the supervisor-actored prompt turns nor the agent replies.
    const all = JSON.stringify(childTurns.map(t => t.content));
    expect(all).not.toContain(PRESENT_HEADING);
    expect(all).not.toContain(PRESENT_MARKER);
    expect(all).not.toContain(REACT_HEADING);
    expect(all).not.toContain('Mock react nudge');
    expect(all).not.toContain(MAINTAIN_HEADING);
    expect(all).not.toContain('Mock maintain nudge');

    // No supervised turn of ANY kind: the agent plan is empty.
    expect(childTurns.some(t => t.actor === 'supervisor')).toBe(false);

    // The turn settled normally.
    expect(readTaskStatus(ctx.root, created.id)).toBe('blocked');
  }, 120000);
});

describe('the hub\'s wrap-up covers accepted children\'s work', () => {
  let ctx: TestContext;

  /** Append [[automation.maintain]] config and commit it (same shape as the
   *  daemonless maintain suite). */
  function enableMaintain(ctx: TestContext, entries: Array<{ title: string; pattern: string; instructions: string }>): void {
    const configPath = join(ctx.root, 'lazy.toml');
    const existing = readFileSync(configPath, 'utf-8');
    const block = entries
      .map(e => `\n[[automation.maintain]]\ntitle = "${e.title}"\npattern = "${e.pattern}"\ninstructions = "${e.instructions}"\n`)
      .join('');
    writeFileSync(configPath, existing + block);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable maintained files');
  }

  /** The newest agent turn carrying a FinalClaim, with the wrap-up audit the
   *  settle path filled in with the steps that actually ran. */
  function declaredClaim(turns: StoredTurn[]): StoredFinalClaim {
    const claimed = claimedTurns(turns);
    const last = claimed[claimed.length - 1];
    if (!last) throw new Error('No final claim found');
    return last.final;
  }

  /** Existence declares final for the next mocked turn — the daemon reads the
   *  path from its own env, so the FILE is the per-turn switch. */
  let finalFlag: string;

  beforeEach(async () => {
    finalFlag = join(tmpdir(), `lazy-hub-final-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    ctx = await setupTestLazy({
      withDaemon: true,
      // INVARIANT: mock switches ride the DAEMON env — the withDaemon mock runs
      // inside the daemon process, and per-invocation env never reaches it.
      // The maintain follow-up commits a changelog entry when nudged.
      daemonEnv: {
        LAZY_MOCK_FINAL: finalFlag,
        LAZY_MOCK_MAINTAIN_FILES: JSON.stringify([
          { path: 'CHANGELOG.md', content: '## Fixed\n- the child\'s feature, covered at the hub\'s final\n' },
        ]),
      },
    });
    disablePreAccept(ctx.root);
    enableMaintain(ctx, [{ title: 'changelog', pattern: 'CHANGELOG.md', instructions: 'Add a changelog line.' }]);
  });

  afterEach(async () => {
    rmSync(finalFlag, { force: true });
    await ctx.cleanup();
  });

  // INVARIANT (final-turn design §4.2): the wrap-up steps at a hub's final run
  // over the hub's whole branch range (base_sha..HEAD), which contains every
  // accepted child's squash — so a child's content is covered even though the
  // child's own final ran none of the steps (agent-audience, §3.2). The
  // negative half is what makes this the deferral rather than a copy: the
  // child was never nudged, and the hub's nudge fired about work the child
  // wrote.
  test('the maintained-file nudge at the hub\'s final fires about an accepted child\'s content', async () => {
    const parentShortId = await createTask(ctx, 'Hub', 'Parent work');
    expectSuccess(await ctx.lazyMocked(['start', parentShortId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expect((await ctx.lazy(['wait', parentShortId])).exitCode).toBe(0);

    // The production route to an agent-audience child: an MCP session acting
    // as the hub's agent creates and starts it, which is the only channel that
    // records the launching actor 'agent' that `audienceOf` reads. A CLI
    // `lazy unblock` here would be a HUMAN launch and would flip the audience,
    // which is the whole thing this test is about.
    const parentFullId = findFullTaskId(ctx.root, parentShortId);
    const parentWorktree = join(ctx.root, '.lazy', 'worktrees', parentShortId);
    writeFileSync(finalFlag, '');
    const mcp = await runMcpSession(ctx.root, parentFullId, parentWorktree, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_create', arguments: { goal: 'Child', prompt: 'Child work' } } },
      {
        method: 'tools/call',
        id: 3,
        params: (prior: JsonRpcResponse[]) => {
          const createReply = prior.find(r => r.id === 2);
          if (!createReply?.result?.content?.[0]) throw new Error('lazy_create produced no reply');
          const created = JSON.parse(createReply.result.content[0].text) as { id: string };
          return { name: 'lazy_start', arguments: { task_id: created.id } };
        },
      },
    ]);
    const childId = (JSON.parse(mcp.find(r => r.id === 2)!.result!.content![0].text) as { id: string }).id;
    expect((await ctx.lazy(['wait', childId])).exitCode).toBe(0);

    // The child's content — the only work on either branch besides the config
    // commit, which predates the hub's branch point.
    const childWorktree = join(ctx.root, '.lazy', 'worktrees', childId);
    mkdirSync(join(childWorktree, 'src'), { recursive: true });
    writeFileSync(join(childWorktree, 'src', 'feature.ts'), 'export const feature = 1;\n');
    expect(ctx.git('-C', childWorktree, 'add', 'src/feature.ts').exitCode).toBe(0);
    expect(ctx.git('-C', childWorktree, 'commit', '-m', 'Child adds the feature').exitCode).toBe(0);

    // The child is agent-audience: its final runs no wrap-up steps at all.
    const childTurns = readTurns(ctx.root, childId);
    const childClaim = declaredClaim(childTurns);
    expect(childClaim.wrap_up_steps).toEqual([]);
    expect(JSON.stringify(childTurns.map(t => t.content))).not.toContain(MAINTAIN_HEADING);

    // Accepted into the hub — its squash is now on the hub's branch. The
    // child's final dispatched an auto-review, and the mock reviewer produces
    // no readable verdict, so this is the override a human uses when they have
    // read the work themselves.
    expectSuccess(await ctx.lazy(['accept', childId, '--yes', '--allow-review-issues']));

    // The hub's final: the maintain step scans base_sha..HEAD — the child's
    // squash is in range, the changelog group was never touched, so the nudge
    // fires HERE, about the child's work.
    expectSuccess(await ctx.lazy(['unblock', parentShortId, '--message', 'Wrap it up']));
    expect((await ctx.lazy(['wait', parentShortId])).exitCode).toBe(0);

    const parentTurns = readTurns(ctx.root, parentShortId);
    const parentClaim = declaredClaim(parentTurns);
    expect(parentClaim.wrap_up_steps).toContain('maintain');
    // INVARIANT (this task): the hub does NOT author a walkthrough — it
    // presents by its children, derived from the accept tags with no model
    // turn. Asking a model to walk a reviewer through a release hub's branch
    // asks for a walkthrough of every feature in the release.
    expect(parentClaim.wrap_up_steps).not.toContain('present');

    const maintainNudges = parentTurns.filter(
      t => t.turn_type === 'nudge' && String(t.content).includes(MAINTAIN_HEADING),
    );
    expect(maintainNudges.length).toBe(1);
    // The skipped group is the changelog — the group the child's feature
    // owed an update to, not one the hub's own work touched.
    expect(String(maintainNudges[0]!.content)).toContain('you skipped changelog');

    // The follow-up landed on the HUB's branch — the follow-up commit the
    // nudge produced covers the child's feature.
    expect(readFileSync(join(parentWorktree, 'CHANGELOG.md'), 'utf-8'))
      .toBe('## Fixed\n- the child\'s feature, covered at the hub\'s final\n');
    expect(ctx.git('-C', parentWorktree, 'log', '--oneline').stdout).toContain('Mock maintain follow-up commit');
  }, 120000);
});
