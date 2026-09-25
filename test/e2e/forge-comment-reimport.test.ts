/**
 * Edited forge comments re-import — end to end through the real GitHub driver
 * (faked at its `runGh` boundary), the real sync path and a real FileStorage.
 *
 * INVARIANT: a forge comment edited while the agent has NOT seen the local copy
 * replaces that copy in place; one edited AFTER the agent saw it arrives as a
 * new comment that names the original. History the agent acted on is never
 * rewritten, and nothing is duplicated.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import { GitHubDriver } from '../../src/remote/github-driver';
import { FileStorage } from '../../src/storage/file-storage';
import { tapStorageEvents } from '../../src/daemon/event-tap';
import { tapParentChildChanges } from '../../src/daemon/parent-child-tap';
import type { Storage } from '../../src/storage/interface';
import type { GhResult } from '../../src/remote';
import type { ResolvedConfig } from '../../src/config/types';

const config: ResolvedConfig = {
  ...DEFAULT_CONFIG,
  remote: { ...DEFAULT_CONFIG.remote, driver: 'github', github_auto_push: false },
};

let issueComments: Array<Record<string, unknown>> = [];
let lineComments: Array<Record<string, unknown>> = [];
const apiCalls: string[][] = [];
const ok = (v: unknown): GhResult => ({ stdout: JSON.stringify(v), stderr: '', exitCode: 0 });
async function fakeGh(args: string[]): Promise<GhResult> {
  if (args[0] === 'repo' && args[1] === 'view') return ok({ isPrivate: true });
  if (args[0] === 'api') {
    apiCalls.push(args);
    if (args[1].endsWith('/issues/42/comments')) return ok(issueComments);
    if (args[1].endsWith('/pulls/42/comments')) return ok(lineComments);
    return ok([]);
  }
  if (args[0] === 'pr' && args[1] === 'view') return ok({ state: 'OPEN' });
  return { stdout: '', stderr: `unexpected gh call: ${args.join(' ')}`, exitCode: 1 };
}

const loaderPath = resolve(import.meta.dir, '../../src/config/loader.ts');
const realLoader = { ...(await import(loaderPath)) };
await mockModule(loaderPath, () => ({ ...realLoader, loadConfig: async () => config }));
const remotePath = resolve(import.meta.dir, '../../src/remote/index.ts');
const realRemote = { ...(await import(remotePath)) };
await mockModule(remotePath, () => ({
  ...realRemote,
  createDriver: () => new GitHubDriver(config, {
    runGh: fakeGh,
    runGit: async () => ({ stdout: '', stderr: 'no git', exitCode: 1 }),
  }),
}));
const { syncTaskFromRemote } = await import('../../src/task/sync-remote');
afterAll(() => restoreMockedModules());

let root: string;
let base: string;
let storage: Storage;
let fileStorage: FileStorage;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lazy-reimport-root-'));
  base = await mkdtemp(join(tmpdir(), 'lazy-reimport-store-'));
  fileStorage = new FileStorage(root, { basePath: base });
  await fileStorage.initialize();
  // The SAME wrapped stack the daemon writes through: a wrapper that dropped
  // an argument once lost every comment's forge identity in production.
  storage = tapParentChildChanges(tapStorageEvents(fileStorage));
  lineComments = [];
  apiCalls.length = 0;
});

afterEach(async () => {
  await fileStorage.close();
  await rm(root, { recursive: true, force: true });
  await rm(base, { recursive: true, force: true });
});

async function prTask() {
  const t = await storage.createTask('g', undefined, undefined, 'reimport', undefined, 'claude-code');
  await storage.updateTaskMetadata(t.id, 'github_remote_ref_id', '42');
  await storage.updateTaskStatus(t.id, 'blocked');
  return (await storage.getTask(t.id))!;
}

const botSummary = (body: string) => [{ id: 900, body, user: { login: 'coderabbitai[bot]' }, created_at: '2026-09-20T00:00:00Z' }];

describe('edited forge comments', () => {
  test('edited before the agent saw it: the local comment is updated in place', async () => {
    const task = await prTask();
    issueComments = botSummary('Summary v1: 2 issues');
    await syncTaskFromRemote(task, storage, root);
    issueComments = botSummary('Summary v2: 1 issue left');
    await syncTaskFromRemote(task, storage, root);

    const comments = await storage.getTaskComments(task.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].content).toContain('Summary v2: 1 issue left');
    expect(comments[0].edited_at).toBeDefined();
    expect(comments[0].external).toMatchObject({ forge: 'github', kind: 'issue_comment', id: '900' });
  });

  test('edited after the agent saw it: a new comment references the original', async () => {
    const task = await prTask();
    issueComments = botSummary('Summary v1: 2 issues');
    await syncTaskFromRemote(task, storage, root);
    const [original] = await storage.getTaskComments(task.id);

    // The agent is shown it.
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/reimport', 'deadbeef');
    await storage.markNotesDelivered(session.id, original.created_at);
    await Bun.sleep(2); // delivery compares ms timestamps

    issueComments = botSummary('Summary v2: 1 issue left');
    await syncTaskFromRemote(task, storage, root);
    await syncTaskFromRemote(task, storage, root); // idempotent

    const comments = await storage.getTaskComments(task.id);
    expect(comments).toHaveLength(2);
    expect(comments[0].content).toContain('Summary v1: 2 issues');
    expect(comments[0].edited_at).toBeUndefined();
    expect(comments[1].revises_comment_id).toBe(original.id);
    expect(comments[1].content).toContain(original.id.substring(0, 8));
    expect(comments[1].content).toContain('Summary v2: 1 issue left');
  });

  // The measured REST cost of one pass: three paginated list calls per task.
  test('one sync pass makes three REST list calls', async () => {
    const task = await prTask();
    issueComments = [];
    await syncTaskFromRemote(task, storage, root);
    expect(apiCalls.length).toBe(3);
  });
});

describe('identity survives the daemon storage stack', () => {
  // INVARIANT: a line comment (whose note ends in "(on file: …)", so no text
  // match can ever recognise it) is imported exactly once across passes.
  test('a line comment is not re-imported on later passes', async () => {
    const task = await prTask();
    issueComments = [];
    lineComments = [{ id: 77, body: 'null check', user: { login: 'bot[bot]' }, created_at: '2026-09-20T00:00:00Z', path: 'src/a.ts', line: 3 }];
    await syncTaskFromRemote(task, storage, root);
    await syncTaskFromRemote(task, storage, root);
    await syncTaskFromRemote(task, storage, root);
    const comments = await storage.getTaskComments(task.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].external).toMatchObject({ forge: 'github', kind: 'line_comment', id: '77' });
  });
});
