/**
 * A daemon restart or stop interrupts a task's turn but KEEPS its container
 * (src/runner/agent-stop.ts), so the session keeps the container's recorded
 * name and agent stamp (src/utils/reconcile.ts, `interruptForDaemonRestart`).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { interruptForDaemonRestart, interruptForDaemonStop } from '../../src/utils/reconcile';
import { mustRecreateForContainerAgent } from '../../src/runner/session-launch';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';

function git(cwd: string, ...args: string[]): string {
  return spawnSyncUnsupervised(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' }).stdout?.toString().trim() ?? '';
}

let lazyRoot: string;
let basePath: string;
let protoBase: string;
let storage: FileStorage;
let baseSha: string;
const savedProto = process.env.LAZY_PROTOCOL_BASE;

beforeEach(async () => {
  process.env.LAZY_TEST = '1';
  lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-interrupt-keep-root-'));
  basePath = await mkdtemp(join(tmpdir(), 'lazy-interrupt-keep-store-'));
  protoBase = await mkdtemp(join(tmpdir(), 'lazy-interrupt-keep-proto-'));
  process.env.LAZY_PROTOCOL_BASE = protoBase;
  git(lazyRoot, 'init', '-q', '-b', 'main');
  git(lazyRoot, 'config', 'user.email', 'test@lazy.test');
  git(lazyRoot, 'config', 'user.name', 'Lazy Test');
  await writeFile(join(lazyRoot, 'README.md'), '# base\n');
  git(lazyRoot, 'add', '.');
  git(lazyRoot, 'commit', '-qm', 'base');
  baseSha = git(lazyRoot, 'rev-parse', 'HEAD');
  storage = new FileStorage(lazyRoot, { basePath });
  await storage.initialize();
});

afterEach(async () => {
  await storage.close();
  if (savedProto === undefined) delete process.env.LAZY_PROTOCOL_BASE;
  else process.env.LAZY_PROTOCOL_BASE = savedProto;
  for (const d of [lazyRoot, basePath, protoBase]) await rm(d, { recursive: true, force: true });
});

async function workingTask() {
  const task = await storage.createTask('kept container', undefined, baseSha);
  const session = await storage.createSession(task.id, 'claude-code', `lazy/${task.id}`, baseSha);
  await storage.updateSessionContainerName(session.id, 'lazy-kept', 'claude-code');
  await storage.updateTaskStatus(task.id, 'working', 'system');
  return task.id;
}

describe('interrupting a turn for a daemon restart or stop', () => {
  // INVARIANT: the container outlives the interrupt, so its record does too.
  // The agent stamp is what makes an agent switched before the resume
  // recreate the container (launch env is fixed at create); clearing it here
  // let the resume reuse a container built for the old agent (review round 3).
  // The name is what the terminal-task sweep removes the container by.
  for (const [label, interrupt] of [
    ['interruptForDaemonRestart (stop trigger)', (id: string) => interruptForDaemonRestart(storage, id, lazyRoot, { trigger: 'stop' })],
    ['interruptForDaemonStop', (id: string) => interruptForDaemonStop(storage, id, lazyRoot)],
  ] as const) {
    test(`${label} keeps the container's name and agent stamp`, async () => {
      const taskId = await workingTask();
      expect(await interrupt(taskId)).toBe(true);
      expect((await storage.getTask(taskId))!.status).toBe('interrupted');
      const session = (await storage.getSessionByTaskId(taskId))!;
      expect(session.container_name).toBe('lazy-kept');
      expect(session.container_agent_id).toBe('claude-code');
      // An agent switched before the resume is detected, so the container is recreated.
      expect(mustRecreateForContainerAgent(session, 'codex')).toBe(true);
    });
  }
});
