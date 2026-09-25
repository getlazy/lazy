/**
 * resolveTurnLaunchIdentity — the ONE rule deciding what a turn launches on.
 *
 * INVARIANT (turn-launch-continuity): a turn runs on the task's CURRENT agent,
 * model and effort — `task.agent_id`, `task.model`, `task.metadata.effort` —
 * unless this launch was handed an explicit override. Every turn type resolves
 * them from this one helper — work turns (start, unblock, resume, auto-resume,
 * auto-deliver), asks, sync/merge turns and pre-accept validation — so no turn
 * type can drift onto a model nobody chose for the task. The behavioural effect
 * is that a turn follows the one before it; the MECHANISM is the task record,
 * never a scan of turn history.
 *
 * The incident: a task was moved to opus mid-flight with `lazy edit --model`,
 * and its next turns still went out on the project's `[models] default`. Two
 * costs, both real — the default was the scarce pool (quota spent from a bucket
 * nobody picked), and switching model between consecutive turns of one session
 * throws the prompt cache away, so the turn AFTER the drift pays as well.
 *
 * ACTIONS PERSIST; ONE-OFFS DO NOT. An override handed to a WORK turn is the
 * human choosing what the task runs on from now on, so it is written to the
 * record. A one-off — an ask, a chat — decides nothing about the task: it reads
 * the record, may use its own effort for that single invocation, and writes
 * nothing back (resolveOneOffTurnIdentity).
 *
 * A machine ONE-SHOT is neither, and nothing here decides one. It has no session
 * to continue (`--resume` is stripped) and no cache to keep warm, so it runs on
 * the BUILDER role target at an effort fixed by its kind, and the task it is
 * about rides along only as attribution. The source scan below holds that line;
 * the runner's own target selection is pinned in oneshot-runner.test.ts.
 *
 * Two halves below, and both are load-bearing:
 *
 *   - the BEHAVIOURAL tests pin the precedence ladder and its persistence, which
 *     is what makes the task record the answer to "what does the next turn run
 *     on" instead of a scan of turn history;
 *   - the SOURCE SCAN pins that every task-turn launch path actually goes
 *     through the helper. Without it the ladder could be perfect and a single
 *     launch path could still resolve its own model — which is exactly the shape
 *     the bug had.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'fs/promises';
import { join, relative } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { FileStorage } from '../../src/storage';
import type { Task } from '../../src/types';
import type { ResolvedConfig, RoleTarget } from '../../src/config/types';
import { ANTHROPIC_DEFAULT_TARGET } from '../../src/config/default-target';
import {
  resolveTurnLaunchIdentity,
  resolveOneOffTurnIdentity,
} from '../../src/daemon/launch-identity';

const SRC = join(import.meta.dir, '..', '..', 'src');

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout?.toString().trim() ?? '';
}

/**
 * A config whose only opinions are the two global defaults.
 *
 * `claude-code` declares no default model of its own (`defaultModel(): null`)
 * and its built-in profile names none, so a task on it falls all the way through
 * to the project overlay / `[models] default` — which is the rung the drift
 * landed on, and therefore the one worth testing against.
 */
function configWith(defaultModel = 'fable', effort: 'low' | 'medium' | 'max' = 'medium'): ResolvedConfig {
  const anthropic = (model = ''): RoleTarget => ({ ...ANTHROPIC_DEFAULT_TARGET, model });
  return {
    models: { default: defaultModel, roles: { builder: anthropic(), agent: anthropic() } },
    agent: { effort, agent_id: 'claude-code' },
  } as unknown as ResolvedConfig;
}

interface Env {
  storage: FileStorage;
  baseSha: string;
  /** A fresh task, re-read from the store so `task` is what a launcher sees. */
  makeTask: (agentId?: string) => Promise<Task>;
  cleanup: () => Promise<void>;
}

async function setupEnv(): Promise<Env> {
  const lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-launch-identity-root-'));
  const basePath = await mkdtemp(join(tmpdir(), 'lazy-launch-identity-store-'));

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
    storage,
    baseSha,
    makeTask: async (agentId = 'claude-code') => {
      const created = await storage.createTask('a task', undefined, baseSha, undefined, undefined, agentId);
      return (await storage.getTask(created.id))!;
    },
    cleanup: async () => {
      await storage.close();
      await Promise.all([
        rm(lazyRoot, { recursive: true, force: true }),
        rm(basePath, { recursive: true, force: true }),
      ]);
    },
  };
}

describe('resolveTurnLaunchIdentity — model', () => {
  let env: Env;

  beforeEach(async () => { env = await setupEnv(); });
  afterEach(async () => { await env.cleanup(); });

  // INVARIANT: this is the reported bug, at its smallest. The task is on opus;
  // the project default is the scarce pool. A launch that names no model must
  // land on opus.
  test("follows the task's stored model over the project default", async () => {
    const task = await env.makeTask();
    await env.storage.updateTaskModel(task.id, 'opus');
    task.model = 'opus';

    const identity = await resolveTurnLaunchIdentity({
      storage: env.storage, task, config: configWith('fable'),
    });

    expect(identity.model).toBe('opus');
  });

  // An override is a durable choice, not a one-turn loan: it is persisted so the
  // NEXT launch inherits it. That write is what makes "the previous turn's
  // model" answerable from the task record — the paths with nobody at the
  // keyboard (auto-resume, auto-deliver) have no override of their own to pass.
  test('an explicit override wins and is inherited by the next turn', async () => {
    const task = await env.makeTask();
    await env.storage.updateTaskModel(task.id, 'fable');
    task.model = 'fable';

    const first = await resolveTurnLaunchIdentity({
      storage: env.storage, task, config: configWith('fable'), modelOverride: 'opus',
    });
    expect(first.model).toBe('opus');
    expect((await env.storage.getTask(task.id))!.model).toBe('opus');

    // The next turn names nothing — and must not fall back to `fable`.
    const next = await resolveTurnLaunchIdentity({
      storage: env.storage, task: (await env.storage.getTask(task.id))!, config: configWith('fable'),
    });
    expect(next.model).toBe('opus');
  });

  // Whichever turn type runs FIRST for a task pins the resolved model, so a
  // later turn never re-reads a config default that changed mid-task. Sync, ask
  // and pre-accept can each be that first turn (a task edited before its start,
  // an ask on a backlog task), which is why the pinning lives in the shared
  // helper rather than in the start path alone.
  test('pins the resolved model when the task has none, and holds it', async () => {
    const task = await env.makeTask();
    expect(task.model ?? null).toBeNull();

    const first = await resolveTurnLaunchIdentity({
      storage: env.storage, task, config: configWith('fable'),
    });
    expect(first.model).toBe('fable');
    expect((await env.storage.getTask(task.id))!.model).toBe('fable');

    // lazy.toml's default moves under the running task. The task does not.
    const later = await resolveTurnLaunchIdentity({
      storage: env.storage, task: (await env.storage.getTask(task.id))!, config: configWith('sonnet'),
    });
    expect(later.model).toBe('fable');
  });

  // INVARIANT (turn-model stickiness): on a profile that PINS an endpoint the
  // task's persisted model still wins — the profile's model is only the default
  // for a task that never had one. It used to go in as a soft preference, which
  // a pinned profile ignores, so `lazy edit --model` on a pi task was recorded
  // and never run: the record said muse-glimmer, every turn ran qwen3.8:latest.
  test("a pinned-endpoint profile runs the task's persisted model, not its own", async () => {
    const config = {
      ...configWith('fable'),
      agents: { 'local-pi': { harness: 'pi', model: 'qwen3.8:latest', endpoint: 'http://localhost:11434' } },
    } as unknown as ResolvedConfig;

    const fresh = await env.makeTask('local-pi');
    const first = await resolveTurnLaunchIdentity({ storage: env.storage, task: fresh, config });
    expect(first.model).toBe('qwen3.8:latest');

    const task = await env.makeTask('local-pi');
    await env.storage.updateTaskModel(task.id, 'muse-glimmer');
    task.model = 'muse-glimmer';
    expect((await resolveTurnLaunchIdentity({ storage: env.storage, task, config })).model).toBe('muse-glimmer');
    expect((await resolveOneOffTurnIdentity({ storage: env.storage, task, config })).model).toBe('muse-glimmer');
  });

  test("the deployment's project-settings overlay outranks lazy.toml", async () => {
    const task = await env.makeTask();
    await env.storage.saveProjectSettings({ defaultModel: 'sonnet' });

    const identity = await resolveTurnLaunchIdentity({
      storage: env.storage, task, config: configWith('fable'),
    });

    expect(identity.model).toBe('sonnet');
  });

  // The overlay is still a PROJECT-wide default, so it sits below the task's own
  // pinned model — same rung `[models] default` sits on (resolveProjectModel).
  test("a stored task model outranks the project overlay", async () => {
    const task = await env.makeTask();
    await env.storage.saveProjectSettings({ defaultModel: 'sonnet' });
    await env.storage.updateTaskModel(task.id, 'opus');
    task.model = 'opus';

    const identity = await resolveTurnLaunchIdentity({
      storage: env.storage, task, config: configWith('fable'),
    });

    expect(identity.model).toBe('opus');
  });

  // INVARIANT: the launch reports the task's OWN profile. Which agent a task
  // runs is `lazy edit --agent` / `lazy unblock --agent`, persisted through
  // switchTaskAgent — never something a launch re-derives from config, or a
  // task pinned to cursor would silently launch on the project's default agent.
  test("reports the task's agent profile, not the config default", async () => {
    const task = await env.makeTask('cursor');

    const identity = await resolveTurnLaunchIdentity({
      storage: env.storage, task, config: configWith('fable'),
    });

    expect(identity.agentId).toBe('cursor');
    // ...and cursor's own declared default outranks the project-wide `fable`,
    // which is an Anthropic name cursor does not serve.
    expect(identity.model).toBe('auto');
  });
});

describe('resolveTurnLaunchIdentity — effort', () => {
  let env: Env;

  beforeEach(async () => { env = await setupEnv(); });
  afterEach(async () => { await env.cleanup(); });

  test("follows the task's stored effort over the config default", async () => {
    const task = await env.makeTask();
    await env.storage.updateTaskMetadata(task.id, 'effort', 'max');
    const fresh = (await env.storage.getTask(task.id))!;

    const identity = await resolveTurnLaunchIdentity({
      storage: env.storage, task: fresh, config: configWith('fable', 'medium'),
    });

    expect(identity.effort).toBe('max');
  });

  test('an explicit effort override wins and is inherited by the next turn', async () => {
    const task = await env.makeTask();

    const first = await resolveTurnLaunchIdentity({
      storage: env.storage, task, config: configWith('fable', 'medium'), effortOverride: 'max',
    });
    expect(first.effort).toBe('max');
    expect((await env.storage.getTask(task.id))!.metadata?.effort).toBe('max');

    const next = await resolveTurnLaunchIdentity({
      storage: env.storage, task: (await env.storage.getTask(task.id))!, config: configWith('fable', 'medium'),
    });
    expect(next.effort).toBe('max');
  });

  test('pins the config effort when the task has none', async () => {
    const task = await env.makeTask();

    const identity = await resolveTurnLaunchIdentity({
      storage: env.storage, task, config: configWith('fable', 'low'),
    });

    expect(identity.effort).toBe('low');
    expect((await env.storage.getTask(task.id))!.metadata?.effort).toBe('low');
  });
});

describe('resolveTurnLaunchIdentity — continuity across turn types', () => {
  let env: Env;

  beforeEach(async () => { env = await setupEnv(); });
  afterEach(async () => { await env.cleanup(); });

  /**
   * The turn types that launch with NO override of their own. Each is a real
   * call site — see the source scan below for the file each lives in.
   *
   * They are exercised as one loop deliberately: the contract is that they are
   * INDISTINGUISHABLE. A turn type that needed its own case here would be a turn
   * type that had grown its own resolution rule again.
   */
  const NO_OVERRIDE_TURN_TYPES = [
    'sync / merge',
    'ask',
    'pre-accept validation',
    'auto-resume after an interruption',
    'auto-delivery of a forge event',
    'the maintained-files nudge that surfaced the bug',
  ];

  test('every turn type without an override lands on what the last one ran', async () => {
    const task = await env.makeTask();
    const config = configWith('fable', 'medium');

    // Turn 1: the human moves the task off the default pool, once.
    const chosen = await resolveTurnLaunchIdentity({
      storage: env.storage, task, config, modelOverride: 'opus', effortOverride: 'max',
    });
    expect(chosen).toEqual({ agentId: 'claude-code', model: 'opus', effort: 'max' });

    for (const turnType of NO_OVERRIDE_TURN_TYPES) {
      const identity = await resolveTurnLaunchIdentity({
        storage: env.storage, task: (await env.storage.getTask(task.id))!, config,
      });
      expect(identity, `${turnType} drifted off the task's model/effort`).toEqual(chosen);
    }
  });
});

/**
 * One-offs — an ask, a chat — decide nothing about the task.
 *
 * Engineer's rule: an ACTION (edit/unblock/start/resume with a model, effort or
 * agent flag) is what makes the next turn move; anything else leaves the task
 * sticky. A reviewer's question is not an action, so its `--effort` covers that
 * question and stops there.
 *
 * The concrete harm this prevents: the per-hunk review TUI asks every one of its
 * questions at a hard-coded `ASK_EFFORT = 'low'`. Persisting that would mean a
 * human who reviewed a task carefully had silently dropped it to low effort for
 * every turn afterwards, with nothing on screen saying so.
 */
describe('resolveOneOffTurnIdentity — an ask writes nothing to the task', () => {
  let env: Env;

  beforeEach(async () => { env = await setupEnv(); });
  afterEach(async () => { await env.cleanup(); });

  test("runs at the ask's own effort while leaving the task's effort alone", async () => {
    const task = await env.makeTask();
    const config = configWith('fable', 'medium');

    // A work turn first: the human puts the task on opus / max.
    await resolveTurnLaunchIdentity({
      storage: env.storage, task, config, modelOverride: 'opus', effortOverride: 'max',
    });

    // Then a reviewer asks a question at low effort.
    const asked = await resolveOneOffTurnIdentity({
      storage: env.storage, task: (await env.storage.getTask(task.id))!, config, effortOverride: 'low',
    });
    expect(asked).toEqual({ agentId: 'claude-code', model: 'opus', effort: 'low' });

    // The record is untouched, so the next WORK turn is still on max.
    const after = (await env.storage.getTask(task.id))!;
    expect(after.model).toBe('opus');
    expect(after.metadata?.effort).toBe('max');
    const next = await resolveTurnLaunchIdentity({ storage: env.storage, task: after, config });
    expect(next).toEqual({ agentId: 'claude-code', model: 'opus', effort: 'max' });
  });

  // The model still comes from the record, which is the whole point: a question
  // asked on a different model misses the prompt cache the work turn just filled,
  // and can spend a pool nobody chose for this task.
  test('takes agent and model from the task record', async () => {
    const task = await env.makeTask();
    await env.storage.updateTaskModel(task.id, 'opus');
    task.model = 'opus';

    const identity = await resolveOneOffTurnIdentity({
      storage: env.storage, task, config: configWith('fable'),
    });

    expect(identity).toEqual({ agentId: 'claude-code', model: 'opus', effort: 'medium' });
  });

  // An unpinned task stays unpinned. resolveTurnLaunchIdentity fills an empty
  // slot on purpose — whichever WORK turn runs first pins the task — but an ask
  // must not be the turn that does the pinning.
  test('does not pin a model or effort onto a task that has neither', async () => {
    const task = await env.makeTask();

    const identity = await resolveOneOffTurnIdentity({
      storage: env.storage, task, config: configWith('fable', 'medium'), effortOverride: 'max',
    });
    expect(identity).toEqual({ agentId: 'claude-code', model: 'fable', effort: 'max' });

    const after = (await env.storage.getTask(task.id))!;
    expect(after.model ?? null).toBeNull();
    expect(after.metadata?.effort ?? null).toBeNull();
  });
});

/**
 * The source scan.
 *
 * The behavioural tests above prove the RULE. These prove every task-turn launch
 * path is subject to it — the half the incident actually turned on, since the
 * drifting path had a perfectly good helper available and did not call it.
 */
describe('every task-turn launch path resolves through the one helper', () => {
  /**
   * Every file that launches a TURN on a task. The turn types, in order:
   * start (task-launcher); unblock, ask, pre-accept and sync (task-lifecycle);
   * auto-delivery (auto-deliver); auto-resume (auto-resume). Supervisor-side
   * turns — the protected-file push-back and the maintained-files nudge — are
   * not here because they do not resolve anything: they inherit the launching
   * command's `agent_id` / `model_id` / `effort` off the wire.
   */
  const LAUNCH_PATHS = [
    'daemon/task-launcher.ts',
    'daemon/task-lifecycle.ts',
    'daemon/auto-deliver.ts',
    'utils/auto-resume.ts',
  ];

  test('each imports and calls resolveTurnLaunchIdentity', async () => {
    for (const rel of LAUNCH_PATHS) {
      const source = await readFile(join(SRC, rel), 'utf-8');
      expect(source, `${rel} does not import resolveTurnLaunchIdentity`)
        .toMatch(/import\s*\{[^}]*\bresolveTurnLaunchIdentity\b[^}]*\}\s*from\s*['"][^'"]*launch-identity['"]/);
      expect(source, `${rel} imports resolveTurnLaunchIdentity but never calls it`)
        .toContain('resolveTurnLaunchIdentity({');
    }
  });

  /**
   * INVARIANT: `resolveAgentModel` is the ladder's implementation, not its entry
   * point. A launch path calling it directly is how a turn type gets its own
   * resolution rule back — it would skip the task-record rung and the write-back
   * that makes the next turn inherit anything.
   *
   * Callers outside the helper, each deliberate:
   *
   *   - daemon/agent-switch.ts — the documented exception. A bare `--agent`
   *     switch DISCARDS the stored model (ids are not portable across agents)
   *     and re-resolves from scratch, persisting the result before any turn
   *     launches. See test/unit/agent-switch.test.ts.
   *
   *   - task/launch-identity-view.ts — a pure DISPLAY read, approved 2026-09-13.
   *     It renders the agent/model/effort the task page header shows, with the
   *     provenance of each; it is synchronous, takes no Storage, writes nothing,
   *     and its only production caller renders HTML. The rule this guard encodes
   *     is about LAUNCH paths, and a read that decides no turn can trigger
   *     neither hazard the rule names: there is no task-record rung to skip and
   *     no next turn to make inherit anything. The two alternatives were both
   *     worse — duplicating the ladder for display is exactly the drift this
   *     invariant exists to prevent, and `resolveOneOffTurnIdentity` is async,
   *     needs Storage, and carries no provenance, so the header could not tell
   *     "recorded on the task" from "resolved from config".
   *
   * The one-shot runner used to be another, resolving a last-resort model off
   * `[models] default` when a caller named none. It no longer resolves a model
   * at all: a one-shot runs the BUILDER role target's model, which the role
   * target already carries. `[models] default` was never right there — an id is
   * only meaningful against the endpoint its own profile resolves to.
   *
   * THE LINE, for whoever trips this next. Forbidden: a launch path calling
   * `resolveAgentModel` directly — that is the whole point of the guard, and the
   * fix is the caller, not this list. Allowed: a pure display read that writes
   * nothing and decides no turn — and it must be named below INDIVIDUALLY.
   *
   * `allowed` is a list of individually-justified exceptions, not a category.
   * Keep the assertion's shape exactly as it is: no prefix glob, no "anything
   * under task/", so the next display read trips this guard too and gets the
   * same deliberate decision instead of passing silently. Adding an entry means
   * answering, in the diff, why that call site is not a turn launch.
   */
  test('resolveAgentModel has no callers outside the helper and one exception', async () => {
    const allowed = new Set([
      'daemon/launch-identity.ts',
      // re-resolves and PERSISTS on a bare `--agent` switch, before any launch
      'daemon/agent-switch.ts',
      // task-page header display read; writes nothing, decides no turn
      'task/launch-identity-view.ts',
    ]);

    const offenders: string[] = [];
    for (const file of await tsFilesUnder(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/');
      if (rel === 'agent/agent-model.ts' || allowed.has(rel)) continue;
      const source = await readFile(file, 'utf-8');
      // Import of the symbol, static or dynamic — a mention in prose does not count.
      if (/(?:import\s*\{[^}]*\bresolveAgentModel\b|\{\s*resolveAgentModel\s*\}\s*=\s*await\s+import)/.test(source)) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * INVARIANT (turn-model-is-a-label): no launch reads a turn's recorded model
   * back. `findStickyModel` scanned turn history for one and outranked the task
   * record with it, so `lazy edit --model` was overruled by a label written at
   * turn 1. Turn labels record what ran; they never decide what runs next.
   */
  test('the sticky-model history scan is not reintroduced', async () => {
    const turnsSource = await readFile(join(SRC, 'utils', 'turns.ts'), 'utf-8');
    expect(turnsSource).not.toMatch(/^\s*export\s+function\s+findStickyModel/m);

    for (const file of await tsFilesUnder(SRC)) {
      const source = await readFile(file, 'utf-8');
      expect(source, `${relative(SRC, file)} imports a sticky-model scan`)
        .not.toMatch(/import\s*\{[^}]*\bfindStickyModel\b/);
    }
  });

  /**
   * INVARIANT (no-launch-path-consults-turn-history): the rule above, held by
   * BEHAVIOUR rather than by one deleted function's name — a scan reintroduced
   * under any other name is the same bug.
   *
   * Two halves:
   *
   *   1. No launch-side module reads a turn's `model` / `model_id` / `effort` /
   *      `agent`. Those fields exist to be DISPLAYED (src/utils/turn-labels.ts),
   *      SERIALIZED (`lazy show`, `lazy report`, the MCP turn shape) and
   *      alias-MIGRATED (file-storage) — all of which are downstream of a launch
   *      and none of which are in this set.
   *   2. Nothing anywhere declares a helper whose NAME says it derives a launch
   *      setting from previous turns. Catching `findStickyModel` by name would
   *      be defeated by `previousTurnModel`; this catches the shape of the idea.
   *
   * If a new launch path is added, list it in LAUNCH_SIDE — a launch path that
   * this guard cannot see is a launch path that can drift.
   */
  test('no launch-side module derives model/effort/agent from turn history', async () => {
    const LAUNCH_SIDE = [
      ...LAUNCH_PATHS,
      'daemon/launch-identity.ts',
      'daemon/effort.ts',
      'daemon/agent-switch.ts',
      'agent/agent-model.ts',
      'supervisor/index.ts',
      'supervisor/merge.ts',
      'supervisor/maintain.ts',
      'supervisor/pushback.ts',
    ];

    // A turn-ish receiver — `turn`, `lastTurn`, `turns[i]` — with a launch-label
    // field read off it. Deliberately NOT `task.model` / `cmd.effort`, which are
    // the record and the wire: the two things a launch SHOULD read.
    const TURN_LABEL_READ =
      /(?:turns\s*\[[^\]]*\]|\b[A-Za-z]*[Tt]urn\b)\s*[?!]?\.\s*(?:model_id|model|effort|agent)\b/;

    for (const rel of LAUNCH_SIDE) {
      const source = await readFile(join(SRC, rel), 'utf-8');
      const offending = source
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        // Prose is where this invariant is explained, so comments are exempt.
        .filter(({ line }) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
        .filter(({ line }) => TURN_LABEL_READ.test(line));

      expect(
        offending.map(o => `${rel}:${o.n}: ${o.line.trim()}`),
        `${rel} reads a launch label off a turn — turn labels are a record of ` +
          `what ran, never an input to what runs next`,
      ).toEqual([]);
    }

    // Half 2: the scan under a new name.
    const RENAMED_SCAN =
      /(?:function|const|let)\s+\w*(?:sticky|previousTurn|priorTurn|lastTurn|turnHistory|inherited)\w*(?:Model|Effort|Agent|Settings|Identity)\b/i;
    for (const file of await tsFilesUnder(SRC)) {
      const source = await readFile(file, 'utf-8');
      expect(source, `${relative(SRC, file)} declares a renamed turn-history scan`)
        .not.toMatch(RENAMED_SCAN);
    }
  });

  /**
   * INVARIANT (one-shots-run-on-the-builder): a task-scoped machine one-shot
   * never resolves its model from the task record — it launches on the BUILDER
   * role target, and names its task only so the call can be ATTRIBUTED.
   *
   * The history is worth keeping straight, because this invariant replaced its
   * own opposite. The synthesizer was first built once per accept — and once per
   * remote-sync SWEEP — from `config.models.default`, so a task pinned to opus
   * got its PR body written on the project default, and one sweep put every
   * task's summary on one project-wide model regardless of pins. The first fix
   * pointed it at the TASK's model instead. The engineer's ruling (2026-09-06)
   * is that both were wrong: a one-shot strips `--resume`, so it continues no
   * session and inherits no prompt cache, and the task's model buys it nothing —
   * it may not even be valid on the builder's harness or endpoint. A one-shot is
   * a fresh-context call lazy makes on the human's behalf, so it runs on the
   * builder target, at an effort fixed by its kind.
   *
   * Three halves, all load-bearing:
   *
   *   1. every task-scoped summarizer still names its task (`taskRef`), because
   *      dropping that silently re-pools every summary's accounting under the
   *      project rather than the task that caused it;
   *   2. the deleted resolver stays deleted, under that name or as a summarizer
   *      built from a model at all;
   *   3. every `regenerateFidelity` call passes a summarizer — the parameter
   *      defaults to `getSummarizer()` in src/synthesis/fidelity.ts, so an
   *      omitted argument is a silent fall back to an unattributed one.
   *
   * The runner half of the rule — that the target IS `builderTarget()` — is
   * pinned behaviourally in test/unit/oneshot-runner.test.ts.
   */
  test('a task-scoped summarizer names its task for attribution, never for a model', async () => {
    const SUMMARIZER_PATHS = ['daemon/task-lifecycle.ts', 'daemon/remote-sync.ts'];

    for (const rel of SUMMARIZER_PATHS) {
      const source = await readFile(join(SRC, rel), 'utf-8');

      const built = [...source.matchAll(/getSummarizer\(/g)].length;
      const attributed = [...source.matchAll(/getSummarizer\([^)]*,\s*taskRef\(/g)].length;
      // Non-vacuity: this file is here because it synthesizes. If it stopped,
      // the check below would pass on 0 === 0 and guard nothing.
      expect(built, `${rel} no longer builds a summarizer — has synthesis moved?`).toBeGreaterThan(0);
      expect(attributed, `${rel} builds ${built} summarizer(s) but attributes only ${attributed} to a task`)
        .toBe(built);

      // A summarizer that reaches regenerateFidelity is only useful if it is
      // actually passed: 4 arguments (storage, task, driver, summarizer).
      const calls = [...source.matchAll(/regenerateFidelity\(([^)]*)\)/g)];
      expect(calls.length, `${rel} no longer calls regenerateFidelity`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call[1].split(',').length, `${rel}: regenerateFidelity(${call[1]}) omits the summarizer`)
          .toBe(4);
      }
    }

    // And nowhere in src does a summarizer take a MODEL — from the config
    // default (the original bug) or from the task record (the first fix).
    for (const file of await tsFilesUnder(SRC)) {
      const source = await readFile(file, 'utf-8');
      const rel = relative(SRC, file).split('\\').join('/');
      expect(source, `${rel} builds a summarizer from the config default`)
        .not.toMatch(/getSummarizer\(\s*config\.models\.default/);
      expect(source, `${rel} resurrects the task-model resolver for one-shots`)
        .not.toContain('resolveTaskOneshotModel');
    }
  });

  /**
   * INVARIANT (one-shots-take-no-model-from-a-task): the resolver is gone, and
   * the shape it had must not come back inline at a call site.
   *
   * `resolveTaskOneshotModel` was one named function, so deleting it is easy to
   * verify — and easy to undo by hand, one `model: task.model` at a time, at the
   * four call sites that used it. Every `runOneshot` request in src is checked
   * here instead: a one-shot may carry a `taskId` (attribution) and must not
   * carry a model derived from that task.
   */
  test('no runOneshot request takes its model from a task', async () => {
    let requests = 0;

    for (const file of await tsFilesUnder(SRC)) {
      const source = await readFile(file, 'utf-8');
      const rel = relative(SRC, file).split('\\').join('/');
      // The request literal, up to its closing brace — call sites write these
      // as a single object literal with no nested braces.
      for (const call of source.matchAll(/runOneshot\(\{([^{}]*)\}/g)) {
        requests++;
        expect(call[1], `${rel}: runOneshot({${call[1]}}) derives a model from a task`)
          .not.toMatch(/model:\s*(?:await\s+)?(?:task|parent|resolveTask)/);
      }
    }

    // Non-vacuity: a regex that matched nothing would guard nothing. The known
    // callers are the fidelity summarizer, `lazy report` (×3), memory
    // compaction and the conversation ask (×3).
    expect(requests, 'no runOneshot request literals found — was the call shape changed?')
      .toBeGreaterThan(5);
  });

  /**
   * INVARIANT (one-offs-are-not-actions): an ask never writes model, effort or
   * agent to the task.
   *
   * Engineer's rule: with no ACTION the task stays sticky, and an ask is not an
   * action. The ask path called the PERSISTING helper, so `lazy_ask` with an
   * effort rewrote the task's effort for every later turn — and the per-hunk
   * review TUI asks every question at a hard-coded `low`.
   *
   * Scanned at FUNCTION scope, not file scope: task-lifecycle.ts legitimately
   * calls the persisting helper for its work, sync and pre-accept turns, so only
   * the ask launcher's own body can say which one the ask uses.
   */
  test('the ask launch path uses the non-persisting helper and writes nothing', async () => {
    const source = await readFile(join(SRC, 'daemon', 'task-lifecycle.ts'), 'utf-8');
    const body = functionBody(source, 'launchAskTaskRun');

    expect(body, 'the ask path does not resolve through resolveOneOffTurnIdentity')
      .toContain('resolveOneOffTurnIdentity({');
    expect(body, 'the ask path uses the PERSISTING helper — an ask is not an action')
      .not.toContain('resolveTurnLaunchIdentity({');

    for (const write of ['updateTaskModel(', 'resolveAndPersistEffort(', "updateTaskMetadata(task.id, 'effort'"]) {
      expect(body, `the ask path calls ${write} — an ask decides nothing about the task`)
        .not.toContain(write);
    }
  });
});

/**
 * One function's body, sliced out of a module — for invariants that hold at
 * function scope inside a file that legitimately does the opposite elsewhere.
 * Throws rather than passing vacuously if the function was renamed.
 */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, 'm'));
  expect(start, `no function ${name} in the source — was the launch path renamed?`).toBeGreaterThan(-1);

  const rest = source.slice(start + 1);
  const end = rest.search(/^(?:export )?(?:async )?function \w+/m);
  return end === -1 ? rest : rest.slice(0, end);
}

async function tsFilesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await tsFilesUnder(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}
