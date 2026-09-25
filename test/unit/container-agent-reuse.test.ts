/**
 * Container recreate on agent switch.
 *
 * INVARIANT (fix-agent-switching-on-tasks): a running task container's launch
 * env is fixed at create time (LAZY_CODEX_API_BASE, CURSOR_API_ENDPOINT, …).
 * After an agent switch, reusing that container leaves the new harness without
 * its wiring. Launch paths must recreate when session.container_agent_id
 * disagrees with task.agent_id; updateSessionAgent seeds the stamp from the
 * previous profile when it was never set (legacy sessions).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { FileStorage } from '../../src/storage';
import { mustRecreateForContainerAgent } from '../../src/runner/session-launch';
import { switchTaskAgent } from '../../src/daemon/agent-switch';
import type { ResolvedConfig, RoleTarget } from '../../src/config/types';
import { ANTHROPIC_DEFAULT_TARGET } from '../../src/config/default-target';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout?.toString().trim() ?? '';
}

function configWith(dflt = 'opus'): ResolvedConfig {
  const anthropic = (model = ''): RoleTarget => ({ ...ANTHROPIC_DEFAULT_TARGET, model });
  return {
    models: { default: dflt, roles: { builder: anthropic(), agent: anthropic() } },
    agent: { effort: 'medium' },
  } as unknown as ResolvedConfig;
}

describe('mustRecreateForContainerAgent', () => {
  test('false when stamp is absent (legacy)', () => {
    expect(mustRecreateForContainerAgent({ container_agent_id: null }, 'cursor')).toBe(false);
    expect(mustRecreateForContainerAgent({}, 'cursor')).toBe(false);
  });

  test('false when stamp matches the task agent', () => {
    expect(mustRecreateForContainerAgent({ container_agent_id: 'cursor' }, 'cursor')).toBe(false);
  });

  test('true when stamp disagrees with the task agent', () => {
    expect(mustRecreateForContainerAgent({ container_agent_id: 'claude-code' }, 'cursor')).toBe(true);
    expect(mustRecreateForContainerAgent({ container_agent_id: 'claude-code' }, 'codex')).toBe(true);
  });
});

describe('updateSessionAgent seeds container_agent_id for legacy sessions', () => {
  let storage: FileStorage;
  let cleanup: () => Promise<void>;
  let baseSha: string;

  beforeEach(async () => {
    const lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-container-agent-root-'));
    const basePath = await mkdtemp(join(tmpdir(), 'lazy-container-agent-store-'));
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
      await Promise.all([
        rm(lazyRoot, { recursive: true, force: true }),
        rm(basePath, { recursive: true, force: true }),
      ]);
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  test('a harness-changing switch seeds the previous agent as the container stamp', async () => {
    const task = await storage.createTask('switch me', undefined, baseSha, undefined, undefined, 'claude-code');
    await storage.updateTaskStatus(task.id, 'blocked', 'human');
    const sess = await storage.createSession(task.id, 'claude-code', 'lazy/switch-me', baseSha, 'claude-sess-1');
    expect(sess.container_agent_id).toBeNull();
    expect(sess.agent_session_id).toBe('claude-sess-1');

    await switchTaskAgent({
      storage,
      task,
      newAgentId: 'cursor',
      config: configWith(),
    });

    const after = await storage.getSessionByTaskId(task.id);
    expect(after).not.toBeNull();
    // Seeded from the previous profile so the next launch sees a mismatch.
    expect(after!.container_agent_id).toBe('claude-code');
    expect(after!.agent_id).toBe('cursor');
    expect(after!.agent_session_id).toBeNull();
    expect(mustRecreateForContainerAgent(after!, 'cursor')).toBe(true);
  });

  test('stamping the launched agent clears the recreate need', async () => {
    const task = await storage.createTask('stamp me', undefined, baseSha, undefined, undefined, 'claude-code');
    await storage.updateTaskStatus(task.id, 'blocked', 'human');
    const sess = await storage.createSession(task.id, 'claude-code', 'lazy/stamp-me', baseSha);

    await switchTaskAgent({
      storage,
      task,
      newAgentId: 'codex',
      config: configWith(),
    });
    const mid = await storage.getSessionByTaskId(task.id);
    expect(mustRecreateForContainerAgent(mid!, 'codex')).toBe(true);

    await storage.updateSessionContainerName(sess.id, 'lazy-stamp-me', 'codex');
    const after = await storage.getSessionByTaskId(task.id);
    expect(after!.container_name).toBe('lazy-stamp-me');
    expect(after!.container_agent_id).toBe('codex');
    expect(mustRecreateForContainerAgent(after!, 'codex')).toBe(false);
  });

  test('clearing the container name also clears the agent stamp', async () => {
    const task = await storage.createTask('clear me', undefined, baseSha, undefined, undefined, 'cursor');
    const sess = await storage.createSession(task.id, 'cursor', 'lazy/clear-me', baseSha);
    await storage.updateSessionContainerName(sess.id, 'lazy-clear-me', 'cursor');

    await storage.updateSessionContainerName(sess.id, null);
    const after = await storage.getSessionByTaskId(task.id);
    expect(after!.container_name).toBeNull();
    expect(after!.container_agent_id).toBeNull();
  });
});
