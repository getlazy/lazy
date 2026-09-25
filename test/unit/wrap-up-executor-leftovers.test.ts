/**
 * The REAL wrap-up executor (src/supervisor/wrap-up.ts#runWrapUpSteps) driving
 * the REAL `commit_leftovers` step against the fake `claude` binary — nothing
 * in src/ is mocked, only the agent binary is fake.
 *
 * The step exists because four tasks in one cluster wrote a file during their
 * end-of-turn checks, never committed it, and reported themselves finished;
 * every one was caught by a human running `git status` by hand. Every other
 * end-of-turn scan reads the COMMITTED range, so this is the only one that can
 * see a working-tree edit at all.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
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
import { listUncommittedPaths } from '../../src/git/operations';
import type { CompletedResponse, FinalDeclaration } from '../../src/protocol/types';

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

describe('wrap-up executor: commit_leftovers (real executor, fake binary)', () => {
  let worktree: string;
  let protocolDir: string;
  let fake: FakeClaude;
  let savedPath: string | undefined;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'lazy-leftovers-exec-'));
    protocolDir = await mkdtemp(join(tmpdir(), 'lazy-leftovers-proto-'));
    const fakeDir = await mkdtemp(join(tmpdir(), 'lazy-leftovers-fake-'));
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

  function buildCtx(opts: { declarations?: Array<FinalDeclaration | undefined> } = {}): {
    ctx: WrapUpStepContext;
    responses: CompletedResponse[];
    phases: string[];
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
      cmd: { task_id: 'leftovers-exec-test', model_id: 'test-model' },
      steps: ['commit_leftovers'],
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
      declaredFinal: true,
    };
    return { ctx, responses, phases };
  }

  test('a clean worktree costs nothing: no invocation, no response, no phase', async () => {
    const { ctx, responses, phases } = buildCtx();
    await runWrapUpSteps(ctx);

    expect(responses).toHaveLength(0);
    expect(phases).toEqual([]);
    expect(await readClaudeInvocations(fake)).toHaveLength(0);
  });

  test('a file the turn wrote and never committed is put to the agent, by name', async () => {
    // Exactly the observed shape: an end-of-turn check wrote a doc and stopped.
    await writeFile(join(worktree, 'docs-note.md'), 'the note\n', 'utf-8');

    await setClaudeScenario(fake, {
      sequence: [{
        steps: [
          { kind: 'emit', event: sessionStartEvent('leftovers-sess-1') },
          { kind: 'commit', message: 'Add the note the maintained-files check asked for', files: [{ path: 'docs-note.md', content: 'the note\n' }] },
          { kind: 'emit', event: resultEvent({ result: 'Committed docs-note.md; nothing discarded.', sessionId: 'leftovers-sess-1' }) },
        ],
      }],
    });

    const before = git(worktree, 'rev-parse', 'HEAD');
    const { ctx, responses, phases } = buildCtx();
    const outcome = await runWrapUpSteps(ctx);

    expect(phases).toEqual(['commit_leftovers', 'commit_leftovers_done']);
    expect(responses).toHaveLength(1);
    expect(responses[0].supervised?.kind).toBe('commit_leftovers');
    // The path is IN the prompt: a nudge that said "something is uncommitted"
    // without naming it would just send the agent back to `git status`.
    expect(responses[0].supervised?.prompt).toContain('docs-note.md');

    // The agent committed, so the step's window shows the branch moving and the
    // worktree comes back clean.
    expect(outcome.lastInvocationSha).not.toBe(before);
    expect(responses[0].start_sha_work).toBe(before);
    expect(responses[0].end_sha_work).toBe(outcome.lastInvocationSha);
    expect(await listUncommittedPaths(worktree)).toEqual([]);

    // Resumed the work session rather than starting a new conversation.
    const invocations = await readClaudeInvocations(fake);
    expect(invocations).toHaveLength(1);
    expect(invocations[0].argv[invocations[0].argv.indexOf('--resume') + 1]).toBe('work-sess-1');
  });

  // INVARIANT: THE SUPERVISOR NEVER COMMITS FOR THE AGENT. An agent that
  // ignores the nudge leaves a dirty worktree, and the turn REPORTS that rather
  // than sweeping it onto the branch — a sweep would put unreviewed content
  // (scratch files, a half-edited config, a pasted key) into the merge under
  // the agent's name.
  test('an agent that ignores the nudge leaves the file loose — nothing is committed for it', async () => {
    await writeFile(join(worktree, 'ignored.md'), 'still here\n', 'utf-8');

    await setClaudeScenario(fake, {
      sequence: [{
        steps: [
          { kind: 'emit', event: sessionStartEvent('leftovers-sess-2') },
          { kind: 'emit', event: resultEvent({ result: 'Noted.', sessionId: 'leftovers-sess-2' }) },
        ],
      }],
    });

    const before = git(worktree, 'rev-parse', 'HEAD');
    const { ctx, responses } = buildCtx();
    const outcome = await runWrapUpSteps(ctx);

    expect(responses).toHaveLength(1);
    expect(outcome.lastInvocationSha).toBe(before);
    expect(await listUncommittedPaths(worktree)).toEqual(['ignored.md']);
  });

  // The turn ending belongs to the invocation that declared it — the same
  // capture-per-step discipline the other wrap-up steps follow.
  test('a final declared during the nudge rides on the nudge response', async () => {
    await writeFile(join(worktree, 'late.md'), 'late work\n', 'utf-8');
    await setClaudeScenario(fake, {
      sequence: [{
        steps: [
          { kind: 'emit', event: sessionStartEvent('leftovers-sess-3') },
          { kind: 'emit', event: resultEvent({ result: 'Committed.', sessionId: 'leftovers-sess-3' }) },
        ],
      }],
    });

    const claim: FinalDeclaration = { sha: 'deadbeef1234', declared_at: new Date().toISOString() };
    const { ctx, responses } = buildCtx({ declarations: [claim] });
    await runWrapUpSteps(ctx);

    expect(responses[0].final).toEqual(claim);
  });

  // A crashed follow-up must not fail the turn: the point of the step is to
  // ASK, and an unanswered question is still better than an errored turn that
  // loses the agent's own account of everything before it.
  test('a follow-up that crashes is recorded and the chain continues', async () => {
    await writeFile(join(worktree, 'orphan.md'), 'x\n', 'utf-8');
    await setClaudeScenario(fake, {
      sequence: [{
        steps: [
          { kind: 'stderr', text: 'boom' },
          { kind: 'exit', code: 1 },
        ],
      }],
    });

    const { ctx, responses, phases } = buildCtx();
    await runWrapUpSteps(ctx);

    expect(phases).toEqual(['commit_leftovers', 'commit_leftovers_done']);
    expect(responses).toHaveLength(1);
    expect(responses[0].result).toContain('follow-up failed');
    // The session is unchanged, so a later step still resumes the work session.
    expect(responses[0].session_id).toBe('work-sess-1');
  });
});
