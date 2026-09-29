/**
 * The agent is told, once, when its environment was replaced between turns.
 *
 * INVARIANT: whenever lazy takes a RUNNING task container away — a member
 * entering the task through a terminal, a credential-kind change, an agent
 * switch — the next work turn's prompt opens with exactly one line saying so,
 * and the turn after it does not. Without it the agent reinstalls nothing and
 * chases "command not found" errors for tools it installed a turn ago.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { FileStorage } from '../../src/storage';
import {
  ENVIRONMENT_REPLACED_KEY,
  REASON_AGENT_CHANGED,
  REASON_CREDENTIAL_CHANGED,
  REASON_MEMBER_ENTERED,
  clearEnvironmentReplaced,
  environmentReplacedLine,
  environmentReplacedPrefix,
  recordRecreationIfRunning,
  recreationReason,
} from '../../src/task/environment-replaced';
import { mustRecreateForContainerAgent } from '../../src/runner/session-launch';
import { switchTaskAgent } from '../../src/daemon/agent-switch';
import { enterTaskAsMember } from '../../src/daemon/member-entry';
import { claimMemberTerminal, releaseMemberTerminal } from '../../src/server/member-terminals';
import type { ResolvedConfig, RoleTarget } from '../../src/config/types';
import { ANTHROPIC_DEFAULT_TARGET } from '../../src/config/default-target';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout?.toString().trim() ?? '';
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const RUNNING = { usesSandbox: () => true, isRunning: async () => true };
const STOPPED = { usesSandbox: () => true, isRunning: async () => false };
const HOST = { usesSandbox: () => false, isRunning: async () => true };

const EXPECTED = (reason: string) =>
  `Your environment was replaced before this turn (${reason}); anything you installed or changed outside the worktree is gone. The worktree itself is intact.`;

describe('environment replaced notice', () => {
  let storage: FileStorage;
  let cleanup: () => Promise<void>;
  let baseSha: string;

  beforeEach(async () => {
    const lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-env-replaced-root-'));
    const basePath = await mkdtemp(join(tmpdir(), 'lazy-env-replaced-store-'));
    git(lazyRoot, 'init');
    git(lazyRoot, 'config', 'user.email', 'test@lazy.test');
    git(lazyRoot, 'config', 'user.name', 'Lazy Test');
    git(lazyRoot, 'checkout', '-b', 'main');
    await writeFile(join(lazyRoot, 'README.md'), '# base\n');
    git(lazyRoot, 'add', '.');
    git(lazyRoot, 'commit', '-m', 'base');
    baseSha = git(lazyRoot, 'rev-parse', 'HEAD');
    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
    cleanup = async () => {
      await storage.close();
      await Promise.all([rm(lazyRoot, { recursive: true, force: true }), rm(basePath, { recursive: true, force: true })]);
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  /** What a work launch does: prompt = prefix + body, then clear once launched. */
  async function launchWorkTurn(taskId: string): Promise<string> {
    const prefix = await environmentReplacedPrefix(storage, taskId);
    const prompt = prefix + 'do the work';
    if (prefix) await clearEnvironmentReplaced(storage, taskId);
    return prompt;
  }

  test('the line reads exactly as specified', () => {
    expect(environmentReplacedLine('x')).toBe(EXPECTED('x'));
  });

  test('member entry: the next work turn carries the line once, the one after does not', async () => {
    const task = await storage.createTask('member', undefined, baseSha, undefined, undefined, 'claude-code');
    await storage.updateTaskStatus(task.id, 'blocked', 'human');
    const sess = await storage.createSession(task.id, 'claude-code', 'lazy/member', baseSha);
    await storage.createTurn({ sessionId: sess.id, sequence: 1, role: 'human', content: 'hi' });

    const email = 'alice@example.com';
    expect(claimMemberTerminal(task.id, email).ok).toBe(true);
    try {
      const entered = await enterTaskAsMember({
        projectRoot: '/p',
        storage,
        taskId: task.id,
        email,
        deps: {
          bindingFor: async () => null,
          pairing: async () => ({ pairing: false, webPairEmail: null }),
          worktreeHolders: async () => ({ webChat: { held: false, email: null }, lock: null }),
          supervisorOwnsTurn: async () => null,
          stopTaskContainer: async () => true,
        },
      });
      expect(entered).toEqual({ ok: true });
    } finally {
      releaseMemberTerminal(task.id, email);
    }

    const first = await launchWorkTurn(task.id);
    expect(count(first, EXPECTED(REASON_MEMBER_ENTERED))).toBe(1);
    expect(first.startsWith(EXPECTED(REASON_MEMBER_ENTERED))).toBe(true);
    expect(count(await launchWorkTurn(task.id), 'Your environment was replaced')).toBe(0);
  });

  test('member entry that found no running container records nothing', async () => {
    const task = await storage.createTask('member idle', undefined, baseSha, undefined, undefined, 'claude-code');
    await storage.updateTaskStatus(task.id, 'blocked', 'human');
    const sess = await storage.createSession(task.id, 'claude-code', 'lazy/member-idle', baseSha);
    await storage.createTurn({ sessionId: sess.id, sequence: 1, role: 'human', content: 'hi' });
    const email = 'bob@example.com';
    expect(claimMemberTerminal(task.id, email).ok).toBe(true);
    try {
      await enterTaskAsMember({
        projectRoot: '/p', storage, taskId: task.id, email,
        deps: {
          bindingFor: async () => null,
          pairing: async () => ({ pairing: false, webPairEmail: null }),
          worktreeHolders: async () => ({ webChat: { held: false, email: null }, lock: null }),
          supervisorOwnsTurn: async () => null,
          stopTaskContainer: async () => false,
        },
      });
    } finally {
      releaseMemberTerminal(task.id, email);
    }
    expect(await launchWorkTurn(task.id)).toBe('do the work');
  });

  test('credential kind change: the recreating launch carries the line once', async () => {
    const task = await storage.createTask('cred', undefined, baseSha, undefined, undefined, 'claude-code');
    await recordRecreationIfRunning(storage, task.id, recreationReason(true, false), RUNNING, "c");
    const first = await launchWorkTurn(task.id);
    expect(count(first, EXPECTED(REASON_CREDENTIAL_CHANGED))).toBe(1);
    expect(count(await launchWorkTurn(task.id), 'Your environment was replaced')).toBe(0);
  });

  test('agent change: the recreating launch carries the line once', async () => {
    const task = await storage.createTask('agent', undefined, baseSha, undefined, undefined, 'claude-code');
    await storage.updateTaskStatus(task.id, 'blocked', 'human');
    await storage.createSession(task.id, 'claude-code', 'lazy/agent', baseSha, 'claude-sess-1');
    await switchTaskAgent({
      storage,
      task,
      newAgentId: 'cursor',
      config: {
        models: { default: 'opus', roles: { builder: { ...ANTHROPIC_DEFAULT_TARGET, model: '' } as RoleTarget, agent: { ...ANTHROPIC_DEFAULT_TARGET, model: '' } as RoleTarget } },
        agent: { effort: 'medium' },
      } as unknown as ResolvedConfig,
    });
    const sess = (await storage.getSessionByTaskId(task.id))!;
    await recordRecreationIfRunning(
      storage, task.id, recreationReason(false, mustRecreateForContainerAgent(sess, 'cursor')), RUNNING, "c",
    );
    const first = await launchWorkTurn(task.id);
    expect(count(first, EXPECTED(REASON_AGENT_CHANGED))).toBe(1);
    expect(count(await launchWorkTurn(task.id), 'Your environment was replaced')).toBe(0);
  });

  test('a recreation of a container that was not running records nothing', async () => {
    const task = await storage.createTask('dead', undefined, baseSha, undefined, undefined, 'claude-code');
    await recordRecreationIfRunning(storage, task.id, recreationReason(true, true), STOPPED, "c");
    expect(await storage.getTaskMetadata(task.id, ENVIRONMENT_REPLACED_KEY)).toBeFalsy();
  });

  test('a host-process run is never reported replaced', async () => {
    const task = await storage.createTask('host', undefined, baseSha, undefined, undefined, 'claude-code');
    await recordRecreationIfRunning(storage, task.id, recreationReason(true, true), HOST, 'c');
    expect(await storage.getTaskMetadata(task.id, ENVIRONMENT_REPLACED_KEY)).toBeFalsy();
  });

  test('replacements before one work turn are told together, each reason once', async () => {
    const task = await storage.createTask('both', undefined, baseSha, undefined, undefined, 'claude-code');
    await recordRecreationIfRunning(storage, task.id, REASON_MEMBER_ENTERED, RUNNING, "c");
    await recordRecreationIfRunning(storage, task.id, REASON_MEMBER_ENTERED, RUNNING, "c");
    await recordRecreationIfRunning(storage, task.id, recreationReason(true, false), RUNNING, "c");
    const first = await launchWorkTurn(task.id);
    expect(count(first, 'Your environment was replaced')).toBe(1);
    expect(count(first, REASON_MEMBER_ENTERED)).toBe(1);
    expect(count(first, REASON_CREDENTIAL_CHANGED)).toBe(1);
  });
});

/**
 * INVARIANT: every work-command path — start, unblock, manual resume,
 * autoResumeTask, autoUnblockTask — prepends the pending notice to the prompt
 * it sends and clears it once launched. A recovery path that forgot would
 * silently drop the notice for exactly the turns most likely to follow a
 * replacement.
 */
describe('every work-command path carries the notice', () => {
  const paths: Array<{ file: string; prompts: RegExp[] }> = [
    { file: 'src/daemon/task-launcher.ts', prompts: [/prompt: envNotice \+ fullPrompt,/] },
    {
      file: 'src/daemon/task-lifecycle.ts',
      prompts: [/prompt: envNotice \+ fullMessage,/, /prompt: envNotice \+ typeConstraintsSection\(task\) \+ fullPrompt,/],
    },
    { file: 'src/utils/auto-resume.ts', prompts: [/prompt: envNotice \+ typeConstraintsSection\(task\) \+ crashContext \+ fullPrompt,/] },
    { file: 'src/daemon/auto-deliver.ts', prompts: [/prompt: envNotice \+ typeConstraintsSection\(task\) \+ fullPrompt,/] },
  ];
  for (const { file, prompts } of paths) {
    test(file, async () => {
      const src = await readFile(join(import.meta.dir, '../..', file), 'utf8');
      for (const re of prompts) expect(src).toMatch(re);
      expect(count(src, 'await environmentReplacedPrefix(')).toBe(prompts.length);
      expect(count(src, 'if (envNotice) await clearEnvironmentReplaced(')).toBe(prompts.length);
    });
  }
});
