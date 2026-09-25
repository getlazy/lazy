/**
 * The REAL wrap-up executor (src/supervisor/wrap-up.ts#runWrapUpSteps) driving
 * the REAL presentation step against the fake `claude` binary — the seam where
 * nothing in src/ is mocked and only the agent binary is fake.
 *
 * The mock-supervisor suites (mock-supervisor-present.test.ts) verify the MOCK
 * reproduces these semantics; THIS suite verifies the semantics themselves, in
 * process, through the same spawn path production uses (buildExecArgs →
 * execWithWatchdog → parseResponse). The fake binary's `write-file` step takes
 * an absolute path, which is what lets a scenario step stand in for the
 * daemon-side lazy_report echo: the declaration is written into the protocol
 * dir exactly where a real MCP call leaves it.
 *
 * INVARIANT (§6.2): the presentation step is the ENFORCEMENT point — the
 * marker is cleared before the invocation, and an absent marker afterwards
 * THROWS before any response is pushed, failing the turn exactly as a failed
 * wrap-up step does today. Each failing shape is asserted with its own cause:
 * no declaration, an UNPARSEABLE declaration, and a crashed invocation.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync } from 'fs';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  installFakeClaude,
  setClaudeScenario,
  readClaudeInvocations,
  sessionStartEvent,
  resultEvent,
  type FakeClaude,
} from '../helpers/fake-claude';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';
import { runWrapUpSteps, type WrapUpStepContext } from '../../src/supervisor/wrap-up';
import type { CompletedResponse, FinalDeclaration } from '../../src/protocol/types';
import { PRESENTATION_MARKER_FILE } from '../../src/protocol/presentation-marker';
import presentRegionsTemplate from '../../src/prompts/present-regions.md' with { type: 'text' };

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

describe('wrap-up executor: present (real executor, fake binary)', () => {
  let worktree: string;
  let protocolDir: string;
  let fake: FakeClaude;
  let savedPath: string | undefined;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'lazy-wrapup-exec-'));
    protocolDir = await mkdtemp(join(tmpdir(), 'lazy-wrapup-exec-proto-'));
    const fakeDir = await mkdtemp(join(tmpdir(), 'lazy-wrapup-exec-fake-'));
    git(worktree, 'init');
    git(worktree, 'config', 'user.email', 't@t.com');
    git(worktree, 'config', 'user.name', 'T');
    await writeFile(join(worktree, 'README.md'), '# R\n', 'utf-8');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'init');
    fake = await installFakeClaude(fakeDir);
    savedPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${process.env.PATH}`;
  });

  afterEach(async () => {
    if (savedPath !== undefined) process.env.PATH = savedPath;
    await rm(worktree, { recursive: true, force: true });
    await rm(protocolDir, { recursive: true, force: true });
    await rm(fake.dir, { recursive: true, force: true });
  });

  /** The declaration the fake binary writes, as a real lazy_report's daemon
   *  side would — same file, same shape, same protocol dir. */
  function declareStep(): { kind: 'write-file'; path: string; content: string } {
    return {
      kind: 'write-file',
      path: join(protocolDir, PRESENTATION_MARKER_FILE),
      content: JSON.stringify({ version: 1, declared_at: new Date().toISOString() }),
    };
  }

  function buildCtx(opts: {
    steps?: WrapUpStepContext['steps'];
    /** Claims captureTurnEnding returns, per call. Undefined afterwards. */
    declarations?: Array<FinalDeclaration | undefined>;
    /** How the turn ended — defaults to a final, which is this suite's subject. */
    declaredFinal?: boolean;
    /** HEAD the walkthrough on record was declared at, as the plan carries it. */
    presentedSha?: string;
  } = {}): {
    ctx: WrapUpStepContext;
    responses: CompletedResponse[];
    phases: string[];
    captureCalls(): number;
  } {
    const responses: CompletedResponse[] = [];
    const phases: string[] = [];
    let captures = 0;
    const declarations = opts.declarations ?? [];
    const ctx: WrapUpStepContext = {
      agent: new ClaudeCodeAgent(),
      worktreePath: worktree,
      protocolDir,
      status: {} as WrapUpStepContext['status'],
      updatePhase: (phase) => { phases.push(phase); },
      cmd: { task_id: 'wrapup-exec-test', model_id: 'test-model' },
      steps: opts.steps ?? ['present'],
      startSha: git(worktree, 'rev-parse', 'HEAD'),
      startSessionId: 'work-sess-1',
      protectedPatterns: [],
      maintainEntries: [],
      reactEntries: [],
      captureTurnEnding: async () => {
        const claim = declarations[captures];
        captures += 1;
        return claim;
      },
      supervisedResponses: responses,
      declaredFinal: opts.declaredFinal ?? true,
      ...(opts.presentedSha ? { presentedSha: opts.presentedSha } : {}),
    };
    return { ctx, responses, phases, captureCalls: () => captures };
  }

  test('happy path: present declares, the phase advances, and the claim rides the present response', async () => {
    await setClaudeScenario(fake, {
      sequence: [
        {
          steps: [
            { kind: 'emit', event: sessionStartEvent('present-sess-1') },
            declareStep(),
            { kind: 'emit', event: resultEvent({ result: 'Authored the walkthrough and re-sent the report with its presentation groups.', sessionId: 'present-sess-1' }) },
          ],
        },
      ],
    });

    const claim: FinalDeclaration = { sha: 'abc1234567890', declared_at: new Date().toISOString() };
    const { ctx, responses, phases, captureCalls } = buildCtx({ declarations: [claim] });
    const outcome = await runWrapUpSteps(ctx);

    expect(phases).toEqual(['present', 'present_done']);
    expect(responses).toHaveLength(1);
    expect(responses[0].supervised?.kind).toBe('present');
    expect(responses[0].session_id).toBe('present-sess-1');
    // The claim made DURING the present invocation rides on its response.
    expect(responses[0].final).toEqual(claim);

    // Session continuity: the step resumed the work session, and the session it
    // reported is what the caller's final nudge resumes — one conversation.
    expect(outcome.lastSessionId).toBe('present-sess-1');
    // The step authors no commits: invocation windows are flat at the caller's
    // start SHA.
    expect(responses[0].start_sha_work).toBe(outcome.lastInvocationSha);
    expect(responses[0].end_sha_work).toBe(outcome.lastInvocationSha);
    // Per-invocation capture discipline (marker read-and-clear per step).
    expect(captureCalls()).toBe(1);

    // The prompt rode on the invocation — read off the fake binary's argv, not
    // from any mock bookkeeping. Same for the --resume chain.
    const invocations = await readClaudeInvocations(fake);
    expect(invocations).toHaveLength(1);
    // The present prompt is the REAL template with the §6.4 hint section
    // substituted — in this sandbox the carve resolves to nothing, so the
    // hint section collapses to its standing prose.
    expect(invocations[0].argv[1]).toBe(presentRegionsTemplate.replace("{{provenance_hint}}", ""));
    expect(invocations[0].argv[invocations[0].argv.indexOf('--resume') + 1]).toBe('work-sess-1');
  });

  // INVARIANT (§6.2): no declaration → the executor THROWS before pushing the
  // present response; the capture for the present invocation never happens.
  test('no declaration: the executor throws and pushes nothing', async () => {
    await setClaudeScenario(fake, {
      sequence: [
        {
          steps: [
            { kind: 'emit', event: sessionStartEvent('present-sess-1') },
            // The agent finished fine but never declared (no write-file step).
            { kind: 'emit', event: resultEvent({ result: 'Done.', sessionId: 'present-sess-1' }) },
          ],
        },
      ],
    });

    const { ctx, responses, captureCalls } = buildCtx();
    await expect(runWrapUpSteps(ctx)).rejects.toThrow('Presentation step did not complete');
    expect(responses).toHaveLength(0);
    expect(captureCalls()).toBe(0);
    expect(existsSync(join(protocolDir, PRESENTATION_MARKER_FILE))).toBe(false);
  });

  test('an unparseable declaration is not a declaration — enforcement fires with the plain cause', async () => {
    await setClaudeScenario(fake, {
      sequence: [
        {
          steps: [
            { kind: 'emit', event: sessionStartEvent('present-sess-1') },
            { kind: 'write-file', path: join(protocolDir, PRESENTATION_MARKER_FILE), content: '{"version":2,"declared_at":"nope"}' },
            { kind: 'emit', event: resultEvent({ result: 'Declared something.', sessionId: 'present-sess-1' }) },
          ],
        },
      ],
    });

    const { ctx, responses } = buildCtx({ steps: ['present'] });
    await expect(runWrapUpSteps(ctx)).rejects.toThrow(
      'Presentation step did not complete: no presentation was declared via lazy_report — send the report again with its presentation groups',
    );
    expect(responses).toHaveLength(0);
  });

  test('a crashed invocation that declared nothing fails with the invocation-failure cause', async () => {
    await setClaudeScenario(fake, {
      sequence: [
        {
          steps: [
            { kind: 'emit', event: sessionStartEvent('present-sess-1') },
            { kind: 'exit', code: 1 },
          ],
        },
      ],
    });

    const { ctx, responses } = buildCtx({ steps: ['present'] });
    await expect(runWrapUpSteps(ctx)).rejects.toThrow(
      'Presentation step did not complete: the invocation failed and no presentation was declared — send the report again with its presentation groups',
    );
    expect(responses).toHaveLength(0);
  });

  // INVARIANT: the wrap-up asks the agent NOTHING about the project. The
  // systemic check that used to close it was removed — it cost a full model
  // turn on the task's context and delayed the accept — so a plan naming it is
  // now just an unimplemented step: logged and skipped, never an invocation.
  test('a plan naming the removed systemic step runs no invocation', async () => {
    await setClaudeScenario(fake, {
      steps: [{ kind: 'emit', event: resultEvent({ result: 'unreached', sessionId: 'nope' }) }],
    });

    const { ctx, responses, phases } = buildCtx({ steps: ['systemic' as never] });
    await runWrapUpSteps(ctx);
    expect(responses).toHaveLength(0);
    expect(phases).toEqual([]);
    expect(await readClaudeInvocations(fake)).toHaveLength(0);
  });

  // INVARIANT (this task): the presentation step is SKIPPED when the
  // walkthrough on record was declared at the current HEAD. A walkthrough
  // describes a diff, so it goes stale only when the diff moves — and this is
  // what makes presenting on EVERY human-facing park affordable rather than a
  // model turn per park. No invocation at all, so nothing can be spent.
  test('head has not moved since the walkthrough: the step does not run', async () => {
    await setClaudeScenario(fake, {
      steps: [{ kind: 'emit', event: resultEvent({ result: 'unreached', sessionId: 'nope' }) }],
    });

    const head = git(worktree, 'rev-parse', 'HEAD');
    const { ctx, responses, phases } = buildCtx({ steps: ['present'], presentedSha: head });
    const outcome = await runWrapUpSteps(ctx);

    expect(responses).toHaveLength(0);
    expect(phases).toEqual([]);
    expect(await readClaudeInvocations(fake)).toHaveLength(0);
    // The session the caller continues from is untouched.
    expect(outcome.lastSessionId).toBe('work-sess-1');
  });

  test('head HAS moved since the walkthrough: the step runs again', async () => {
    await setClaudeScenario(fake, {
      steps: [
        { kind: 'emit', event: sessionStartEvent('present-sess-2') },
        declareStep(),
        { kind: 'emit', event: resultEvent({ result: 'Re-walked the new head.', sessionId: 'present-sess-2' }) },
      ],
    });

    const { ctx, responses } = buildCtx({ steps: ['present'], presentedSha: 'a'.repeat(40) });
    await runWrapUpSteps(ctx);

    expect(responses).toHaveLength(1);
    expect(responses[0].supervised?.kind).toBe('present');
  });

  // INVARIANT (this task): the §6.2 enforcement is FINAL-ONLY. A task parking
  // for a human is already stopping; turning "the agent stopped" into "the turn
  // errored" would cost that human the agent's own account of where it got to,
  // on top of the walkthrough they did not get. The next park runs the step
  // again, so nothing is permanently lost either.
  test('a PARK that declared no presentation warns and carries on', async () => {
    await setClaudeScenario(fake, {
      sequence: [
        {
          steps: [
            { kind: 'emit', event: sessionStartEvent('present-sess-1') },
            // Finished fine, declared nothing.
            { kind: 'emit', event: resultEvent({ result: 'Done.', sessionId: 'present-sess-1' }) },
          ],
        },
      ],
    });

    const { ctx, responses } = buildCtx({ steps: ['present'], declaredFinal: false });
    const outcome = await runWrapUpSteps(ctx);

    // No throw. The invocation still happened, so it is still recorded — its
    // tokens were spent and its output is the agent's last word on the turn.
    expect(responses).toHaveLength(1);
    expect(responses[0].supervised?.kind).toBe('present');
    expect(outcome.lastSessionId).toBe('present-sess-1');
  });

  // INVARIANT (review 131bab8c; rule 4 of this task's brief — "auto-review only
  // on a final", so needs-input and plain blocked get the presentation and no
  // review turn): THE PRESENTATION STEP CANNOT DECIDE THE TURN'S ENDING. A
  // `lazy_final` made DURING the walkthrough invocation on a park is dropped,
  // not carried home.
  //
  // The step now runs on every human-facing park, and its prompt opens with
  // "your turn is ending" — the cue the tool instructions attach the
  // pencils-down tool to — so an agent declaring here is the expected case, not
  // an exotic one. If this guard regresses, a task parked mid-work is recorded
  // as declared-done, the auto-review dispatches a turn nobody asked for, and
  // the declaration is attributed to a walkthrough step rather than to any
  // judgement about the code. The prompt asking the agent not to is not the
  // guard; the drop is, which is why it is asserted here rather than trusted.
  test('a PARK cannot be turned into a final by the walkthrough step', async () => {
    await setClaudeScenario(fake, {
      sequence: [
        {
          steps: [
            { kind: 'emit', event: sessionStartEvent('present-sess-1') },
            declareStep(),
            { kind: 'emit', event: resultEvent({ result: 'Authored the walkthrough — and declared final while I was at it.', sessionId: 'present-sess-1' }) },
          ],
        },
      ],
    });

    const claim: FinalDeclaration = { sha: 'abc1234567890', declared_at: new Date().toISOString() };
    const { ctx, responses, captureCalls } = buildCtx({
      steps: ['present'],
      declaredFinal: false,
      declarations: [claim],
    });
    await runWrapUpSteps(ctx);

    // The step ran and is recorded — its tokens were spent and the walkthrough
    // it authored is real. What it may not do is change how the turn ended.
    expect(responses).toHaveLength(1);
    expect(responses[0].supervised?.kind).toBe('present');
    // THE ASSERTION: no claim rides home, so the reconciler stamps no
    // `Turn.final`, the task stays parked, and no auto-review is dispatched.
    expect(responses[0].final).toBeUndefined();
    // The turn-ending marker was still READ AND CLEARED, exactly as on a final:
    // dropping the claim is a decision about what rides home, not a licence to
    // leave it in the protocol dir for the next invocation to pick up.
    expect(captureCalls()).toBe(1);
  });

  // The other half of the same rule, so neither test can pass by the claim
  // simply never being captured: on a turn that DID declare, the claim made
  // during the present step rides home exactly as the happy path shows.
  test('a FINAL turn still carries a claim made during the walkthrough step', async () => {
    await setClaudeScenario(fake, {
      sequence: [
        {
          steps: [
            { kind: 'emit', event: sessionStartEvent('present-sess-1') },
            declareStep(),
            { kind: 'emit', event: resultEvent({ result: 'Authored the walkthrough.', sessionId: 'present-sess-1' }) },
          ],
        },
      ],
    });

    const claim: FinalDeclaration = { sha: 'def1234567890', declared_at: new Date().toISOString() };
    const { ctx, responses } = buildCtx({
      steps: ['present'],
      declaredFinal: true,
      declarations: [claim],
    });
    await runWrapUpSteps(ctx);

    expect(responses[0].final).toEqual(claim);
  });

  test('a plan step this supervisor does not implement is logged and skipped, not fatal', async () => {
    await setClaudeScenario(fake, {
      steps: [
        { kind: 'emit', event: sessionStartEvent('present-sess-1') },
        declareStep(),
        { kind: 'emit', event: resultEvent({ result: 'Declared.', sessionId: 'present-sess-1' }) },
      ],
    });

    const { ctx, responses } = buildCtx({ steps: ['present', 'future_step' as never] });
    const outcome = await runWrapUpSteps(ctx);
    expect(responses).toHaveLength(1);
    expect(outcome.lastSessionId).toBe('present-sess-1');
  });
});
// INVARIANT (final-turn design §4.2): the maintained-file and protected-file
// wrap-up steps run at a hub's final over the hub's WHOLE branch range — base
// sha..HEAD, accepted children's squashes included — so their prompts tell the
// agent the check covers work its accepted children wrote ("you have their
// reports"). Asserted against the REAL step prompts flowing to a real agent
// argv: this is a prompt-CONTENT contract, and the module mock cannot carry it
// (it fabricates canned prompts; only the fake binary shows what the real
// supervisor built).
describe('wrap-up executor: children-coverage lines in maintain and push-back prompts (real executor, fake binary)', () => {
  let worktree: string;
  let protocolDir: string;
  let fake: FakeClaude;
  let savedPath: string | undefined;
  let initSha: string;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'lazy-wrapup-children-'));
    protocolDir = await mkdtemp(join(tmpdir(), 'lazy-wrapup-children-proto-'));
    const fakeDir = await mkdtemp(join(tmpdir(), 'lazy-wrapup-children-fake-'));
    git(worktree, 'init');
    git(worktree, 'config', 'user.email', 't@t.com');
    git(worktree, 'config', 'user.name', 'T');
    // A protected file exists at the range start; a non-maintained tree too.
    await writeFile(join(worktree, 'a.spec.ts'), 'describe("a", () => it("works", () => {}));\n', 'utf-8');
    await writeFile(join(worktree, 'README.md'), '# R\n', 'utf-8');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'init');
    initSha = git(worktree, 'rev-parse', 'HEAD');
    // The "task's" change: rewrites the protected file, adds an unmaintained
    // source file. Whichever step scans initSha..HEAD sees this range.
    await writeFile(join(worktree, 'a.spec.ts'), 'describe("a", () => it("changed", () => {}));\n', 'utf-8');
    await mkdirSync(join(worktree, 'src'), { recursive: true });
    await writeFile(join(worktree, 'src', 'feature.ts'), 'export const feature = 1;\n', 'utf-8');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'task change');
    fake = await installFakeClaude(fakeDir);
    savedPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${process.env.PATH}`;
  });

  afterEach(async () => {
    if (savedPath !== undefined) process.env.PATH = savedPath;
    await rm(worktree, { recursive: true, force: true });
    await rm(protocolDir, { recursive: true, force: true });
    await rm(fake.dir, { recursive: true, force: true });
  });

  function buildCtx(opts: {
    steps: WrapUpStepContext['steps'];
    protectedPatterns?: string[];
    maintainEntries?: WrapUpStepContext['maintainEntries'];
    baseSha?: string;
  }): {
    ctx: WrapUpStepContext;
    responses: CompletedResponse[];
  } {
    const responses: CompletedResponse[] = [];
    const ctx: WrapUpStepContext = {
      agent: new ClaudeCodeAgent(),
      worktreePath: worktree,
      protocolDir,
      status: {} as WrapUpStepContext['status'],
      updatePhase: () => {},
      // The wrap-up command's base_sha is what makes the range branch-wide
      // (§4.2): scanStart = cmd.base_sha ?? startSha.
      cmd: { task_id: 'wrapup-children-test', model_id: 'test-model', ...(opts.baseSha ? { base_sha: opts.baseSha } : {}) },
      steps: opts.steps,
      startSha: git(worktree, 'rev-parse', 'HEAD'),
      startSessionId: 'work-sess-1',
      protectedPatterns: opts.protectedPatterns ?? [],
      maintainEntries: opts.maintainEntries ?? [],
      reactEntries: [],
      captureTurnEnding: async () => undefined,
      supervisedResponses: responses,
      declaredFinal: true,
    };
    return { ctx, responses };
  }

  test('the maintain prompt tells the agent its accepted children\'s docs work is covered', async () => {
    await setClaudeScenario(fake, {
      sequence: [
        {
          steps: [
            { kind: 'emit', event: sessionStartEvent('maintain-sess-1') },
            { kind: 'emit', event: resultEvent({ result: 'Docs updated for the whole branch.', sessionId: 'maintain-sess-1' }) },
          ],
        },
      ],
    });

    const { ctx, responses } = buildCtx({
      steps: ['maintain'],
      baseSha: initSha,
      maintainEntries: [{ title: 'changelog', pattern: 'CHANGELOG.md', instructions: 'Add a changelog line.' }],
    });
    await runWrapUpSteps(ctx);

    const invocations = await readClaudeInvocations(fake);
    expect(invocations).toHaveLength(1);
    const prompt = invocations[0].argv[1] as string;
    // Rendered, not raw: the placeholders were substituted.
    expect(prompt).not.toContain('{{');
    // Whitespace-normalized: the template's hand-wrapping must not be part of
    // the contract.
    const flat = prompt.replace(/\s+/g, ' ');
    expect(flat).toContain('including work your children wrote');
    expect(flat).toContain('you have their reports');
    // The skipped group rode along (this run's range is the branch, and the
    // changelog was untouched in it).
    expect(prompt).toContain('changelog');
    expect(responses[0].supervised?.kind).toBe('maintain');
  });

  test('the push-back prompt tells the agent some files may be accepted children\'s work', async () => {
    await setClaudeScenario(fake, {
      sequence: [
        {
          steps: [
            { kind: 'emit', event: sessionStartEvent('pushback-sess-1') },
            { kind: 'emit', event: resultEvent({ result: 'Justified the spec rewrite.', sessionId: 'pushback-sess-1' }) },
          ],
        },
      ],
    });

    const { ctx, responses } = buildCtx({
      steps: ['permission_pushback'],
      baseSha: initSha,
      protectedPatterns: ['*.spec.ts'],
    });
    await runWrapUpSteps(ctx);

    const invocations = await readClaudeInvocations(fake);
    expect(invocations).toHaveLength(1);
    const prompt = invocations[0].argv[1] as string;
    expect(prompt).not.toContain('{{');
    const flat = prompt.replace(/\s+/g, ' ');
    expect(flat).toContain('may have been changed by accepted children of this task');
    expect(flat).toContain('you have their reports');
    expect(prompt).toContain('a.spec.ts');
    // The violation stands after the agent declined to revert — the response
    // records it for the accept gate.
    expect(responses[0].supervised?.kind).toBe('permission_pushback');
    expect((responses[0] as CompletedResponse & { violations?: unknown[] }).violations?.map((v) => (v as { file: string }).file)).toContain('a.spec.ts');
  });
});
