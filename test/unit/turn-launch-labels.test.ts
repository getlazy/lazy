/**
 * Unit tests for per-turn launch labels: `agent`, `model`, `model_id`, and
 * `effort`.
 *
 * A Turn used to carry token usage but no record of WHICH agent, model or
 * effort produced it. `task.agent_id`, `task.model` and `task.metadata.effort`
 * are all task-level and last-value-wins, so a mid-task agent switch (`lazy edit
 * --agent`), model override or effort change erased the history of what each
 * turn actually ran under. These fields close that gap.
 *
 * INVARIANTS this file encodes:
 *
 *   1. Two distinct fields. `model` is the REQUEST-side resolution (what the
 *      host put in `--model`, usually a tier alias); `model_id` is the CONCRETE
 *      id the agent self-reported. `model_id` is never back-filled from the
 *      alias — its absence is the signal that only the alias was ever known.
 *   2. Sticky-model resolution reads REQUEST-side turns only. Agent turns now
 *      carry `model` too; reading them would let a concrete snapshot harden
 *      into the pin for every later launch.
 *   3. Labels are recorded per INVOCATION, not per command: work, push-back and
 *      maintain follow-ups each carry their own.
 *   4. Old turns stay readable and stay unlabelled. A response from a supervisor
 *      built before these fields existed yields a turn with no labels rather
 *      than a turn labelled with a guess.
 *   5. An absent label RENDERS as `unknown` on every surface, and is never
 *      filled in from the task's current agent/model/effort.
 *
 *   6. A turn lazy AUTHORED itself (supervisor nudge/sync note, `[system]`
 *      notice) ran no agent, so it renders no labels at all — `unknown` would
 *      claim we lost a record that never existed.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { handleCompletedResponses, handleErrorResponse } from '../../src/utils/reconcile';
import { findStickyModel, launchSettingsFromResponse } from '../../src/utils/turns';
import { formatTurnLaunchLabels, turnLaunchLabels, turnRanNoAgent } from '../../src/utils/turn-labels';
import { extractModelId } from '../../src/agent/claude-code';
import { protocolDir as getProtocolDir } from '../../src/protocol';
import type { CompletedResponse } from '../../src/protocol';
import { getWorktreePathForRef, taskRef } from '../../src/cli/helpers';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import type { Turn } from '../../src/types';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSyncUnsupervised(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return result.stdout?.toString().trim() ?? '';
}

interface Env {
  lazyRoot: string;
  storage: FileStorage;
  baseSha: string;
  cleanup: () => Promise<void>;
}

async function setupEnv(): Promise<Env> {
  const lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-labels-root-'));
  const basePath = await mkdtemp(join(tmpdir(), 'lazy-labels-store-'));

  git(lazyRoot, 'init');
  git(lazyRoot, 'config', 'user.email', 'test@lazy.test');
  git(lazyRoot, 'config', 'user.name', 'Lazy Test');
  git(lazyRoot, 'checkout', '-b', 'main');
  await writeFile(join(lazyRoot, 'README.md'), '# base\n');
  git(lazyRoot, 'add', '.');
  git(lazyRoot, 'commit', '-m', 'base');
  const baseSha = git(lazyRoot, 'rev-parse', 'HEAD');

  const storage = new FileStorage(lazyRoot, { basePath });
  await storage.initialize();

  return {
    lazyRoot,
    storage,
    baseSha,
    cleanup: async () => {
      await storage.close();
      await Promise.all([
        rm(lazyRoot, { recursive: true, force: true }),
        rm(basePath, { recursive: true, force: true }),
      ]);
    },
  };
}

/** A `working` task with a session, a worktree, and a recorded human turn. */
async function makeWorkingTask(
  env: Env,
  goal: string,
  human: { model?: string; effort?: string } = {},
): Promise<{ ref: string; taskId: string; sessionId: string }> {
  const task = await env.storage.createTask(goal, undefined, env.baseSha);
  const ref = taskRef(task);
  const branch = `lazy/${ref}`;

  const session = await env.storage.createSession(task.id, 'claude-code', branch, env.baseSha);
  await env.storage.updateTaskStatus(task.id, 'working', 'system');

  git(env.lazyRoot, 'branch', branch, env.baseSha);
  const wt = getWorktreePathForRef(env.lazyRoot, ref);
  await mkdir(dirname(wt), { recursive: true });
  git(env.lazyRoot, 'worktree', 'add', wt, branch);

  await env.storage.createTurn({
    sessionId: session.id,
    sequence: await env.storage.getNextTurnSequence(session.id),
    role: 'human',
    content: 'Do the work.',
    actor: 'human',
    ...human,
  });

  return { ref, taskId: task.id, sessionId: session.id };
}

function sessionArg(session: { id: string; agent_session_id: string | null; git_start_sha: string; container_name: string | null }) {
  return {
    id: session.id,
    agent_session_id: session.agent_session_id,
    git_start_sha: session.git_start_sha,
    container_name: session.container_name,
  };
}

const USAGE = { input_tokens: 100, output_tokens: 200 };

describe('extractModelId', () => {
  test('prefers a flat `model` field', () => {
    expect(extractModelId({ model: 'claude-opus-4-6-20260101' })).toBe('claude-opus-4-6-20260101');
  });

  test('falls back to the modelUsage key that did the most work', () => {
    // WHY the max-output-tokens key: Claude Code bills small side-task models
    // (haiku for summarization) into the same map. Taking the first key would
    // label a whole opus turn as haiku.
    const modelId = extractModelId({
      modelUsage: {
        'claude-haiku-4-5-20251001': { inputTokens: 900, outputTokens: 12 },
        'claude-opus-4-6-20260101': { inputTokens: 100, outputTokens: 4000 },
      },
    });
    expect(modelId).toBe('claude-opus-4-6-20260101');
  });

  test('accepts snake_case token keys in modelUsage entries', () => {
    const modelId = extractModelId({
      modelUsage: {
        'model-small': { output_tokens: 5 },
        'model-big': { output_tokens: 500 },
      },
    });
    expect(modelId).toBe('model-big');
  });

  // INVARIANT 1: no invention. Nothing to report → undefined, so the caller
  // records the alias alone rather than a fabricated concrete id.
  test('returns undefined when the result carries no model identity', () => {
    expect(extractModelId({ result: 'done', usage: USAGE })).toBeUndefined();
    expect(extractModelId({ model: '   ' })).toBeUndefined();
    expect(extractModelId({ modelUsage: {} })).toBeUndefined();
    expect(extractModelId({ modelUsage: null })).toBeUndefined();
    expect(extractModelId({ modelUsage: ['claude-opus-4-6'] })).toBeUndefined();
  });
});

describe('launchSettingsFromResponse', () => {
  test('maps the protocol field names onto CreateTurnOptions names', () => {
    expect(launchSettingsFromResponse({ agent: 'cursor', model: 'opus', model_id: 'claude-opus-4-6-20260101', effort: 'high' }))
      .toEqual({ agent: 'cursor', model: 'opus', modelId: 'claude-opus-4-6-20260101', effort: 'high' });
  });

  // INVARIANT 4: an older supervisor's response carries none of these fields.
  // The mapping must yield an EMPTY object — not keys set to undefined, which
  // would still write null columns and read as "we knew it was nothing".
  test('omits every field a response did not carry', () => {
    expect(launchSettingsFromResponse({})).toEqual({});
    expect(launchSettingsFromResponse({ model: 'opus' })).toEqual({ model: 'opus' });
    // Specifically: no `agent` key at all, rather than one that would later be
    // rendered as if the turn had actually been launched with something.
    expect('agent' in launchSettingsFromResponse({ model: 'opus' })).toBe(false);
  });
});

describe('findStickyModel', () => {
  const turn = (over: Partial<Turn>): Turn => ({
    id: 't', session_id: 's', sequence: 1, role: 'human', content: 'x', timestamp: 0, ...over,
  } as Turn);

  test('returns the most recent request-side model', () => {
    expect(findStickyModel([
      turn({ sequence: 1, role: 'human', model: 'sonnet' }),
      turn({ sequence: 2, role: 'human', model: 'opus' }),
    ])).toBe('opus');
  });

  // INVARIANT 2 (sticky-model-is-request-side): agent turns record what RAN,
  // including a concrete dated id. If the sticky scan read them, one turn's
  // snapshot would pin every future launch to a model the human never chose.
  test('skips agent turns even though they now carry a model', () => {
    expect(findStickyModel([
      turn({ sequence: 1, role: 'human', model: 'opus' }),
      turn({ sequence: 2, role: 'agent', model: 'opus', model_id: 'claude-opus-4-6-20260101' }),
    ])).toBe('opus');
  });

  test('returns undefined when no request-side turn recorded a model', () => {
    expect(findStickyModel([turn({ role: 'agent', model: 'opus' })])).toBeUndefined();
    expect(findStickyModel([])).toBeUndefined();
  });
});

describe('turn launch labels: storage round-trip', () => {
  let env: Env;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    env = await setupEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test('FileStorage persists agent, model, model_id and effort', async () => {
    const task = await env.storage.createTask('round-trip', undefined, env.baseSha);
    const session = await env.storage.createSession(task.id, 'claude-code', 'lazy/rt', env.baseSha);

    await env.storage.createTurn({
      sessionId: session.id, sequence: 0, role: 'agent', content: 'labelled',
      agent: 'cursor', model: 'opus', modelId: 'claude-opus-4-6-20260101', effort: 'high',
    });

    const [turn] = await env.storage.getSessionTurns(session.id);
    // Deliberately NOT the session's agent ('claude-code'): the turn records
    // what IT was launched with, which is the whole point after a mid-task switch.
    expect(turn.agent).toBe('cursor');
    expect(turn.model).toBe('opus');
    expect(turn.model_id).toBe('claude-opus-4-6-20260101');
    expect(turn.effort).toBe('high');
  });

  // INVARIANT 4: turns written before this feature (and turns whose agent
  // reported no concrete id) must stay readable with the fields simply absent.
  // No migration, no back-fill from the task's current model/effort.
  test('a turn recorded without the labels reads back with them absent', async () => {
    const task = await env.storage.createTask('unlabelled', undefined, env.baseSha);
    const session = await env.storage.createSession(task.id, 'claude-code', 'lazy/un', env.baseSha);

    await env.storage.createTurn({
      sessionId: session.id, sequence: 0, role: 'agent', content: 'unlabelled', model: 'opus',
    });

    const [turn] = await env.storage.getSessionTurns(session.id);
    expect(turn.model).toBe('opus');
    expect(turn.model_id).toBeUndefined();
    expect(turn.effort).toBeUndefined();
    // INVARIANT: absent means UNKNOWN. The session's agent is 'claude-code' and
    // storage must NOT reach for it — a turn recorded without an agent stays
    // without one.
    expect(turn.agent).toBeUndefined();
  });
});

describe('reconciler: stamping launch labels onto turns', () => {
  let env: Env;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    env = await setupEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // INVARIANT 3: per-invocation. The work turn and each supervised follow-up
  // carry the labels of the `claude -p` run that produced them.
  test('work and supervised turns each carry their own labels', async () => {
    const { ref, taskId, sessionId } = await makeWorkingTask(env, 'labelled work', { model: 'opus', effort: 'high' });
    const session = await env.storage.getSessionByTaskId(ref);
    const worktreePath = getWorktreePathForRef(env.lazyRoot, ref);

    const responses: CompletedResponse[] = [
      {
        status: 'completed', result: 'Did the work.', session_id: 'sess-work', usage: USAGE,
        agent: 'claude-code', model: 'opus', model_id: 'claude-opus-4-6-20260101', effort: 'high',
      },
      {
        status: 'completed', result: 'Docs updated.', session_id: 'sess-maintain', usage: USAGE,
        start_sha_work: env.baseSha, end_sha_work: env.baseSha,
        agent: 'claude-code', model: 'opus', model_id: 'claude-opus-4-6-20260101', effort: 'high',
        supervised: { kind: 'maintain', prompt: 'You skipped docs. Update or justify.' },
      },
    ];

    await handleCompletedResponses(env.storage, taskId, sessionArg(session!), responses, worktreePath, getProtocolDir(taskId));

    const turns = await env.storage.getSessionTurns(sessionId);
    const agentTurns = turns.filter(t => t.role === 'agent');
    expect(agentTurns).toHaveLength(2);
    for (const t of agentTurns) {
      expect(t.agent).toBe('claude-code');
      expect(t.model).toBe('opus');
      expect(t.model_id).toBe('claude-opus-4-6-20260101');
      expect(t.effort).toBe('high');
    }

    // The supervisor's own prompt turn ran no model — labelling it would claim
    // a model produced text it never saw.
    const promptTurn = turns.find(t => t.turn_type === 'nudge' && t.role === 'human')!;
    expect(promptTurn.actor).toBe('supervisor');
    expect(promptTurn.agent).toBeUndefined();
    expect(promptTurn.model).toBeUndefined();
    expect(promptTurn.model_id).toBeUndefined();
    expect(promptTurn.effort).toBeUndefined();
  });

  // INVARIANT 1: the alias is never copied into model_id. A local/proxy backend
  // that forces a concrete model still reports nothing, and that must stay
  // distinguishable from an agent that named its model.
  test('a response with no concrete id records the alias alone', async () => {
    const { ref, taskId, sessionId } = await makeWorkingTask(env, 'alias only', { model: 'sonnet' });
    const session = await env.storage.getSessionByTaskId(ref);
    const worktreePath = getWorktreePathForRef(env.lazyRoot, ref);

    await handleCompletedResponses(
      env.storage, taskId, sessionArg(session!),
      [{ status: 'completed', result: 'Done.', session_id: 'sess-1', usage: USAGE, model: 'sonnet', effort: 'medium' }],
      worktreePath, getProtocolDir(taskId),
    );

    const agentTurn = (await env.storage.getSessionTurns(sessionId)).filter(t => t.role === 'agent')[0];
    expect(agentTurn.model).toBe('sonnet');
    expect(agentTurn.effort).toBe('medium');
    expect(agentTurn.model_id).toBeUndefined();
  });

  // A crash is data. "model X keeps crashing" is exactly the kind of finding a
  // model comparison exists to surface, so the crash turn carries its labels —
  // there is no `model_id` counterpart because a crashed invocation produced no
  // parseable result to report one.
  test('a crash turn records the agent, model and effort it ran under', async () => {
    const { ref, taskId, sessionId } = await makeWorkingTask(env, 'crashing model', { model: 'opus' });
    const session = await env.storage.getSessionByTaskId(ref);

    await handleErrorResponse(
      env.storage, taskId, { id: session!.id },
      {
        status: 'error', error: 'model provider rejected the credential', phase: 'work',
        failure_class: 'fatal_auth', agent: 'cursor', model: 'opus', effort: 'high',
      },
      getProtocolDir(taskId), env.lazyRoot,
    );

    const last = (await env.storage.getSessionTurns(sessionId)).at(-1)!;
    expect(last.role).toBe('agent');
    expect(last.content).toContain('unrecoverable');
    // "agent X keeps crashing" is a real finding — dropping the label here would
    // silently exclude failures from any agent comparison.
    expect(last.agent).toBe('cursor');
    expect(last.model).toBe('opus');
    expect(last.effort).toBe('high');
    expect(last.model_id).toBeUndefined();
  });

  // INVARIANT 4: a pre-feature supervisor writes responses without the fields.
  // The turn must record none of them rather than inherit the task's model.
  test('a response from a pre-feature supervisor yields an unlabelled turn', async () => {
    const { ref, taskId, sessionId } = await makeWorkingTask(env, 'legacy response', { model: 'opus' });
    const session = await env.storage.getSessionByTaskId(ref);
    const worktreePath = getWorktreePathForRef(env.lazyRoot, ref);

    await handleCompletedResponses(
      env.storage, taskId, sessionArg(session!),
      [{ status: 'completed', result: 'Done.', session_id: 'sess-1', usage: USAGE }],
      worktreePath, getProtocolDir(taskId),
    );

    const agentTurn = (await env.storage.getSessionTurns(sessionId)).filter(t => t.role === 'agent')[0];
    expect(agentTurn.model).toBeUndefined();
    expect(agentTurn.model_id).toBeUndefined();
    expect(agentTurn.effort).toBeUndefined();
    // The task IS running under an agent ('claude-code' — every task has one),
    // and the turn still records none. That is the point: the response did not
    // say, so the turn does not claim.
    expect(agentTurn.agent).toBeUndefined();
  });
});

describe('turn launch labels: rendering', () => {
  const turn = (over: Partial<Turn>): Turn => ({
    id: 't', session_id: 's', sequence: 1, role: 'agent', content: 'x', timestamp: 0, ...over,
  } as Turn);

  test('renders agent, model and effort in a fixed order', () => {
    expect(formatTurnLaunchLabels(turn({ agent: 'cursor', model: 'opus', effort: 'high' })))
      .toBe('agent: cursor · model: opus · effort: high');
  });

  test('folds a differing concrete model_id into the model label', () => {
    expect(turnLaunchLabels(turn({ agent: 'claude-code', model: 'opus', model_id: 'claude-opus-4-6-20260101', effort: 'low' })))
      .toEqual(['agent: claude-code', 'model: opus (claude-opus-4-6-20260101)', 'effort: low']);
    // Nothing to add when the agent reported back the alias it was given.
    expect(turnLaunchLabels(turn({ model: 'opus', model_id: 'opus' }))[1]).toBe('model: opus');
  });

  // INVARIANT 5 (absent-renders-as-unknown): a turn that recorded no agent
  // renders `agent: unknown` — NEVER the task's current agent, and never the
  // configured default.
  //
  // WHY this test exists: the tempting future "fix" is exactly to fill the blank
  // in from the task. Every turn written before `Turn.agent` existed is blank,
  // and `lazy edit --agent` switches a task's agent mid-flight — so a renderer
  // that reached for `task.agent_id` would confidently label old turns with an
  // agent that never ran them. That is worse than `unknown`, because it is
  // wrong in exactly the case someone is trying to investigate. Same argument
  // for model and effort. If this test is failing because a surface now passes
  // task context to the formatter, the surface is the bug.
  test('an unrecorded field renders as unknown, never as a default', () => {
    expect(formatTurnLaunchLabels(turn({})))
      .toBe('agent: unknown · model: unknown · effort: unknown');
    // Formatter takes ONLY the turn: there is no parameter through which a
    // caller could supply the task's agent as a fallback.
    expect(formatTurnLaunchLabels.length).toBe(1);
    expect(formatTurnLaunchLabels(turn({ model: 'opus' })))
      .toBe('agent: unknown · model: opus · effort: unknown');
  });

  // INVARIANT 6 (nothing-ran is not unknown): a turn lazy wrote ITSELF renders
  // no launch labels at all — not `unknown`.
  //
  // WHY this test exists: `unknown` is a claim that a turn ran something we
  // failed to record. Supervisor nudge prompts, sync merge notes and `[system]`
  // notices ran nothing — lazy authored that text — so there was never anything
  // to record, and labelling them `unknown` reports phantom missing data on the
  // turns that are working exactly as designed. They are not rare either: a
  // maintained-files nudge lands on most tasks. The tempting future
  // "simplification" is to collapse the two cases back into one branch, which
  // silently reintroduces the phantom. Keep them distinct.
  test('a turn lazy wrote itself renders no labels, not unknown', () => {
    // Supervisor-authored: the nudge prompt and the sync merge note.
    expect(turnLaunchLabels(turn({ role: 'human', actor: 'supervisor', turn_type: 'nudge' }))).toEqual([]);
    expect(formatTurnLaunchLabels(turn({ role: 'human', actor: 'supervisor', turn_type: 'sync' }))).toBe('');
    // Daemon-authored '[system]' notices (auto-resume, auto-deliver).
    expect(formatTurnLaunchLabels(turn({ role: 'human', actor: 'system' }))).toBe('');
    expect(turnRanNoAgent(turn({ role: 'human', actor: 'system' }))).toBe(true);
  });

  // The counter-case that keeps INVARIANT 6 narrow: some lazy-authored turns DO
  // belong to a launch and are stamped for it (the pre-accept '[system]' turn
  // records what the validation ran under). Those must render normally — the
  // rule is "carries no label AND lazy wrote it", not "lazy wrote it".
  test('a lazy-authored turn that DID record a launch still renders its labels', () => {
    expect(formatTurnLaunchLabels(turn({ role: 'human', actor: 'system', agent: 'claude-code', model: 'opus', effort: 'high' })))
      .toBe('agent: claude-code · model: opus · effort: high');
    expect(turnRanNoAgent(turn({ role: 'human', actor: 'system', agent: 'claude-code' }))).toBe(false);
  });

  // And the other side of the line: a HUMAN-authored turn with no labels is a
  // genuine gap (a turn from before these fields existed), so it keeps saying
  // unknown. Actor is what separates the two — never the emptiness alone.
  test('an unlabelled human turn still says unknown', () => {
    expect(formatTurnLaunchLabels(turn({ role: 'human', actor: 'human' })))
      .toBe('agent: unknown · model: unknown · effort: unknown');
    expect(formatTurnLaunchLabels(turn({ role: 'agent' })))
      .toBe('agent: unknown · model: unknown · effort: unknown');
  });

  // A backend that only ever knew the concrete id still says something more
  // useful than `unknown`.
  test('falls back to the concrete model_id when no alias was recorded', () => {
    expect(turnLaunchLabels(turn({ model_id: 'claude-opus-4-6-20260101' }))[1])
      .toBe('model: claude-opus-4-6-20260101');
  });
});
