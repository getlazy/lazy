/**
 * switchTaskAgent — re-resolve model/effort on an agent change.
 *
 * INVARIANT (fix-agent-switch-resolution): a bare agent switch must not carry
 * the previous agent's stored model/effort into the next launch. Model ids are
 * not portable across agents; the incident was a claude-code→cursor switch that
 * kept `opus` and died in fatal_auth on Cursor's Opus quota.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { FileStorage } from '../../src/storage';
import type { ResolvedConfig, RoleTarget } from '../../src/config/types';
import { ANTHROPIC_DEFAULT_TARGET } from '../../src/config/default-target';
import {
  switchTaskAgent,
  formatAgentSwitchAnnouncement,
} from '../../src/daemon/agent-switch';
import { resolveAgentModel } from '../../src/agent/agent-model';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout?.toString().trim() ?? '';
}

/**
 * `agents` is the project's `[agents.<name>]` blocks. Omitted, the four built-in
 * profiles are all that exist — which is every case below except the
 * two-profiles-one-harness switch, the only one that needs a second profile
 * running a harness a built-in already runs.
 */
function configWith(
  dflt = 'opus',
  effort: 'medium' | 'high' = 'medium',
  agents?: Record<string, Record<string, string>>,
): ResolvedConfig {
  const anthropic = (model = ''): RoleTarget => ({ ...ANTHROPIC_DEFAULT_TARGET, model });
  return {
    models: { default: dflt, roles: { builder: anthropic(), agent: anthropic() } },
    agent: { effort },
    ...(agents ? { agents } : {}),
  } as unknown as ResolvedConfig;
}

interface Env {
  storage: FileStorage;
  baseSha: string;
  cleanup: () => Promise<void>;
}

async function setupEnv(): Promise<Env> {
  const lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-agent-switch-root-'));
  const basePath = await mkdtemp(join(tmpdir(), 'lazy-agent-switch-store-'));

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
    cleanup: async () => {
      await storage.close();
      await Promise.all([
        rm(lazyRoot, { recursive: true, force: true }),
        rm(basePath, { recursive: true, force: true }),
      ]);
    },
  };
}

describe('switchTaskAgent', () => {
  let env: Env;

  beforeEach(async () => {
    env = await setupEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // INVARIANT: bare switch to cursor drops a stored Anthropic model and lands
  // on Cursor's declared default — the incident that created this task.
  test('bare switch to cursor re-resolves opus → auto', async () => {
    const task = await env.storage.createTask('switch me', undefined, env.baseSha, undefined, undefined, 'claude-code');
    await env.storage.updateTaskModel(task.id, 'opus');
    await env.storage.updateTaskMetadata(task.id, 'effort', 'high');
    const fresh = (await env.storage.getTask(task.id))!;

    const result = await switchTaskAgent({
      storage: env.storage,
      task: fresh,
      newAgentId: 'cursor',
      config: configWith('opus', 'medium'),
    });

    expect(result.previousAgent).toBe('claude-code');
    expect(result.agent).toBe('cursor');
    expect(result.previousModel).toBe('opus');
    expect(result.model).toBe('auto');
    expect(result.modelReResolved).toBe(true);
    expect(result.previousEffort).toBe('high');
    expect(result.effort).toBe('medium');
    expect(result.effortReResolved).toBe(true);

    const stored = (await env.storage.getTask(task.id))!;
    expect(stored.agent_id).toBe('cursor');
    expect(stored.model).toBe('auto');
    expect(stored.metadata?.effort).toBe('medium');
  });

  // INVARIANT (edited-task-model-wins — fix-unblock-sticky-model): after a
  // bare switch, the model a LAUNCH resolves is the re-resolved task.model, and
  // prior request turns recorded under the OLD agent have no say.
  //
  // This replaces the deleted findStickyModel agent-filter tests. Launches used
  // to scan back to the most recent request-side turn ("sticky model"), which
  // outranked task.model — so fix-agent-switch-resolution had to teach that scan
  // to skip turns from a different agent, or a claude-code `opus` turn would
  // pin the first Cursor launch to Opus. The scan is gone; the guard now lives
  // in the data, because switchTaskAgent WRITES the re-resolved model into
  // task.model and a launch reads only that.
  test('a launch after a bare switch reads the re-resolved model, not a prior turn', async () => {
    const task = await env.storage.createTask('switch with history', undefined, env.baseSha, undefined, undefined, 'claude-code');
    await env.storage.updateTaskModel(task.id, 'opus');
    const sess = await env.storage.createSession(task.id, 'claude-code', 'lazy/switch-with-history', env.baseSha);
    // A request turn from the OLD agent — exactly what the old scan would have found.
    await env.storage.createTurn({
      sessionId: sess.id, sequence: 1, role: 'human', content: 'do work',
      agent: 'claude-code', model: 'opus',
    });

    const fresh = (await env.storage.getTask(task.id))!;
    const config = configWith('opus', 'medium');
    await switchTaskAgent({ storage: env.storage, task: fresh, newAgentId: 'cursor', config });

    const stored = (await env.storage.getTask(task.id))!;
    // Resolve the way every launch path does: override (none) > task.model.
    const launchModel = resolveAgentModel(config, {
      preferredModel: stored.model,
      agentId: stored.agent_id,
    });
    expect(launchModel).toBe('auto');
    expect(launchModel).not.toBe('opus');
  });

  // INVARIANT: co-supplied model/effort are "chosen for THIS agent" and survive.
  test('switch with co-supplied model/effort keeps those values', async () => {
    const task = await env.storage.createTask('pin me', undefined, env.baseSha, undefined, undefined, 'claude-code');
    await env.storage.updateTaskModel(task.id, 'opus');
    const fresh = (await env.storage.getTask(task.id))!;

    const result = await switchTaskAgent({
      storage: env.storage,
      task: fresh,
      newAgentId: 'cursor',
      config: configWith('opus'),
      modelOverride: 'gpt-5',
      effortOverride: 'low',
    });

    expect(result.model).toBe('gpt-5');
    expect(result.modelReResolved).toBe(false);
    expect(result.effort).toBe('low');
    expect(result.effortReResolved).toBe(false);

    const stored = (await env.storage.getTask(task.id))!;
    expect(stored.model).toBe('gpt-5');
    expect(stored.metadata?.effort).toBe('low');
  });

  test('resets the session agent_session_id when a session exists', async () => {
    const task = await env.storage.createTask('started', undefined, env.baseSha);
    const sess = await env.storage.createSession(task.id, 'claude-code', 'lazy/x', env.baseSha, 'claude-sess-abc');
    await env.storage.updateTaskModel(task.id, 'opus');
    const fresh = (await env.storage.getTask(task.id))!;

    const result = await switchTaskAgent({
      storage: env.storage,
      task: fresh,
      newAgentId: 'cursor',
      config: configWith(),
    });

    expect(result.sessionReset).toBe(true);
    const after = await env.storage.getSessionByTaskId(task.id);
    expect(after!.agent_id).toBe('cursor');
    expect(after!.agent_session_id ?? null).toBeNull();
  });

  // ...and the other half: a session is a HARNESS artifact, not a profile one.
  // `--resume <id>` is read by the agent BINARY, and only that binary's own
  // session format can make sense of it — so two profiles that run the same
  // binary, differing only in which upstream the proxy forwards to, are a
  // `--model`-class change and the conversation survives. Resetting on every
  // profile change would throw away context for a change the agent cannot see,
  // which is why the reset is keyed on the harness and not on the name.
  test('keeps the session when both profiles run the same harness', async () => {
    const config = configWith('opus', 'medium', {
      'work-claude': {
        harness: 'claude-code',
        model: 'claude-opus-5',
        endpoint: 'https://anthropic-gateway.internal',
      },
    });
    const task = await env.storage.createTask('same harness', undefined, env.baseSha, undefined, undefined, 'claude-code');
    await env.storage.createSession(task.id, 'claude-code', 'lazy/x', env.baseSha, 'claude-sess-keep');
    const fresh = (await env.storage.getTask(task.id))!;

    const result = await switchTaskAgent({
      storage: env.storage,
      task: fresh,
      newAgentId: 'work-claude',
      config,
    });

    expect(result.sessionKept).toBe(true);
    expect(result.sessionReset).toBe(false);

    const after = await env.storage.getSessionByTaskId(task.id);
    // The conversation is still resumable...
    expect(after!.agent_session_id).toBe('claude-sess-keep');
    // ...and the session names the profile the task now runs, not the harness.
    expect(after!.agent_id).toBe('work-claude');
    expect((await env.storage.getTask(task.id))!.agent_id).toBe('work-claude');

    // The human is told which of the two happened — "session kept" is not the
    // absence of a line, it is its own one.
    const announced = formatAgentSwitchAnnouncement(result).join('\n');
    expect(announced).toContain('session kept');
    expect(announced).not.toContain('session reset');
  });

  // INVARIANT (fix-edit-agent-status-gate): switching agents while a turn is
  // in flight clears agent_session_id and races the running turn writing it
  // back. Refuse `working`; blocked/interrupted are the supported retarget paths.
  test('refuses a switch while the task is working', async () => {
    const task = await env.storage.createTask('busy', undefined, env.baseSha);
    await env.storage.createSession(task.id, 'claude-code', 'lazy/x', env.baseSha, 'claude-sess-busy');
    await env.storage.updateTaskStatus(task.id, 'working');
    const fresh = (await env.storage.getTask(task.id))!;

    await expect(switchTaskAgent({
      storage: env.storage,
      task: fresh,
      newAgentId: 'cursor',
      config: configWith(),
    })).rejects.toThrow(/turn is in flight/);

    const stored = (await env.storage.getTask(task.id))!;
    expect(stored.agent_id).toBe('claude-code');
    const sess = await env.storage.getSessionByTaskId(task.id);
    expect(sess!.agent_session_id).toBe('claude-sess-busy');
  });

  test('allows a switch on a blocked task', async () => {
    const task = await env.storage.createTask('blocked', undefined, env.baseSha);
    await env.storage.createSession(task.id, 'claude-code', 'lazy/x', env.baseSha, 'claude-sess-1');
    await env.storage.updateTaskStatus(task.id, 'blocked');
    const fresh = (await env.storage.getTask(task.id))!;

    const result = await switchTaskAgent({
      storage: env.storage,
      task: fresh,
      newAgentId: 'cursor',
      config: configWith(),
    });

    expect(result.agent).toBe('cursor');
    expect((await env.storage.getTask(task.id))!.agent_id).toBe('cursor');
  });

  test('allows a switch on an interrupted task', async () => {
    const task = await env.storage.createTask('interrupted', undefined, env.baseSha);
    await env.storage.createSession(task.id, 'claude-code', 'lazy/x', env.baseSha, 'claude-sess-2');
    await env.storage.updateTaskStatus(task.id, 'working');
    await env.storage.updateTaskStatus(task.id, 'interrupted');
    const fresh = (await env.storage.getTask(task.id))!;

    const result = await switchTaskAgent({
      storage: env.storage,
      task: fresh,
      newAgentId: 'cursor',
      config: configWith(),
    });

    expect(result.agent).toBe('cursor');
    expect((await env.storage.getTask(task.id))!.agent_id).toBe('cursor');
  });

  test('rejects an unknown agent without writing', async () => {
    const task = await env.storage.createTask('keep me', undefined, env.baseSha);
    await env.storage.updateTaskModel(task.id, 'opus');
    const fresh = (await env.storage.getTask(task.id))!;

    await expect(switchTaskAgent({
      storage: env.storage,
      task: fresh,
      newAgentId: 'not-an-agent',
      config: configWith(),
    })).rejects.toThrow(/Unknown agent/);

    const stored = (await env.storage.getTask(task.id))!;
    expect(stored.agent_id).toBe('claude-code');
    expect(stored.model).toBe('opus');
  });

  test('rejects an empty co-supplied model', async () => {
    const task = await env.storage.createTask('empty model', undefined, env.baseSha);
    const fresh = (await env.storage.getTask(task.id))!;

    await expect(switchTaskAgent({
      storage: env.storage,
      task: fresh,
      newAgentId: 'cursor',
      config: configWith(),
      modelOverride: '   ',
    })).rejects.toThrow(/Model name cannot be empty/);
  });

  test('formatAgentSwitchAnnouncement names the before/after values', () => {
    const lines = formatAgentSwitchAnnouncement({
      previousAgent: 'claude-code',
      agent: 'cursor',
      previousModel: 'opus',
      model: 'auto',
      previousEffort: 'high',
      effort: 'medium',
      modelChanged: true,
      effortChanged: true,
      sessionReset: true,
      sessionKept: false,
      modelReResolved: true,
      effortReResolved: true,
    });
    expect(lines[0]).toContain('claude-code → cursor');
    expect(lines.some(l => l.includes('opus → auto'))).toBe(true);
    expect(lines.some(l => l.includes('high → medium'))).toBe(true);
  });
});
