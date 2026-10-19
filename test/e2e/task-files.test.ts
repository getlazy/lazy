/**
 * `taskFiles` — per-task secret files, end to end (src/daemon/task-files.ts).
 *
 * Uses the fake-binary seam so the file travels the REAL path: control RPC →
 * daemon registry → delivery into the worktree at launch → a supervised agent
 * whose own `git add -A && git commit` (the fake's `commit` step) must leave it
 * out. Then the negative half: the content appears nowhere durable, no read
 * returns it, and intake refuses paths that would escape the worktree.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess, expectFailure, expectError, expectOutputExcludes } from '../helpers/assertions';
import { successScenario } from '../helpers/fake-claude';
import { storageDirFor } from '../helpers/storage';
import { getTaskFilesPath } from '../../src/daemon/paths';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { runGit } from '../../src/utils/git';

const SECRET = 'API_TOKEN=sk-dummy-task-file-7c21e9-value\n';
const NEEDLE = 'sk-dummy-task-file-7c21e9-value';

async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile()) continue;
      const text = await readFile(path, 'utf-8').catch(() => '');
      if (text.includes(needle)) hits.push(path);
    }
  };
  await walk(dir);
  return hits;
}

interface TaskFilesResult {
  taskId: string;
  paths: string[];
  retired?: string[];
  delivery: { written: string[]; refused: Array<{ path: string; reason: string }>; retired: string[] } | null;
}

describe('taskFiles (per-task secret files)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    const registry = getTaskFilesPath(ctx.root);
    await ctx.cleanup();
    await rm(registry, { force: true });
  });

  async function rpc(params: Record<string, unknown>): Promise<TaskFilesResult> {
    const client = await DaemonClient.create(ctx.root);
    if (!client) throw new Error('test daemon is not running');
    return await client.rpc('taskFiles', ctx.root, params) as TaskFilesResult;
  }

  async function worktreeOf(taskRef: string): Promise<string> {
    const dir = join(ctx.root, '.lazy', 'worktrees');
    const names = await readdir(dir);
    const name = names.find(n => n === taskRef || n.startsWith(taskRef)) ?? names[0];
    return join(dir, name);
  }

  // INVARIANT: a delivered file reaches the task's worktree at launch and is
  // never in a commit — not even one the agent makes itself with `git add -A`.
  test('delivered at start, absent from the agent\'s own commit, and nowhere durable', async () => {
    const taskId = await createTask(ctx, 'Secret file delivery', 'Do the work');
    const set = await rpc({ action: 'set', taskId, files: [{ path: '.env', contents: SECRET }, { path: 'config/sa.json', contents: `{"k":"${NEEDLE}"}` }] });
    expect(set.paths).toEqual(['.env', 'config/sa.json']);
    expect(set.delivery).toBeNull(); // no worktree yet: delivered at start
    expect(JSON.stringify(set)).not.toContain(NEEDLE);

    await ctx.setClaudeScenario({
      ...successScenario({ result: 'done', sessionId: 'fake-sess-files' }),
      steps: [
        { kind: 'commit', message: 'agent work', files: [{ path: 'work.txt', content: 'real work\n' }] },
        ...successScenario({ result: 'done', sessionId: 'fake-sess-files' }).steps,
      ],
    });
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const worktree = await worktreeOf(taskId);
    expect(await readFile(join(worktree, '.env'), 'utf-8')).toBe(SECRET);
    expect((await stat(join(worktree, '.env'))).mode & 0o777).toBe(0o600);

    const tree = (await runGit(['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: worktree })).stdout.split('\n');
    expect(tree).toContain('work.txt');
    expect(tree).not.toContain('.env');
    expect(tree).not.toContain('config/sa.json');

    // Nowhere durable: the store (turns, prompts, task JSON) and the project's
    // .lazy — except the delivered files themselves in the worktree.
    expect(await filesContaining(storageDirFor(ctx.root), NEEDLE)).toEqual([]);
    const inLazy = (await filesContaining(join(ctx.root, '.lazy'), NEEDLE))
      .filter(p => p !== join(worktree, '.env') && p !== join(worktree, 'config/sa.json'));
    expect(inLazy).toEqual([]);

    // list: paths only.
    const list = await rpc({ action: 'list', taskId });
    expect(list.paths).toEqual(['.env', 'config/sa.json']);
    expect(JSON.stringify(list)).not.toContain(NEEDLE);
  }, 120_000);

  // INVARIANT: the next launch repairs a delivered file a merge or the agent
  // changed, and a path the branch TRACKS is refused, never overwritten —
  // with the refusal returned to the caller.
  test('a tracked path is refused through the RPC; the next launch repairs an edited file', async () => {
    const taskId = await createTask(ctx, 'Secret file tracked path', 'Do the work');
    await ctx.setClaudeScenario(successScenario({ result: 'done', sessionId: 'fake-sess-tracked' }));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    const worktree = await worktreeOf(taskId);

    const set = await rpc({ action: 'set', taskId, files: [{ path: 'README.md', contents: SECRET }, { path: '.env', contents: SECRET }] });
    expect(set.delivery?.written).toEqual(['.env']);
    expect(set.delivery?.refused.map(r => r.path)).toEqual(['README.md']);
    expect(set.delivery?.refused[0].reason).toContain('tracks a file');
    expect(await readFile(join(worktree, 'README.md'), 'utf-8')).not.toContain(NEEDLE);

    await writeFile(join(worktree, '.env'), 'clobbered\n');
    expectSuccess(await ctx.lazy(['unblock', taskId, '--message', 'again', '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(await readFile(join(worktree, '.env'), 'utf-8')).toBe(SECRET);
  }, 180_000);

  // INVARIANT: accept never merges a delivered secret file — not when it sits
  // on the branch tip, and not when a later commit deleted it again (the
  // history is what reaches the target). Refused naming the path, never the
  // content.
  test('accept refuses a branch carrying a delivered file, at the tip or only in history', async () => {
    const taskId = await createTask(ctx, 'Secret file accept guard', 'Do the work');
    await rpc({ action: 'set', taskId, files: [{ path: '.env', contents: SECRET }] });
    await ctx.setClaudeScenario({
      ...successScenario({ result: 'done', sessionId: 'fake-sess-accept' }),
      steps: [
        { kind: 'commit', message: 'agent work', files: [{ path: 'work.txt', content: 'real work\n' }] },
        ...successScenario({ result: 'done', sessionId: 'fake-sess-accept' }).steps,
      ],
    });
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    const worktree = await worktreeOf(taskId);

    // What the exclusion cannot stop: a force-add committed with raw git.
    expect((await runGit(['add', '-f', '.env'], { cwd: worktree })).exitCode).toBe(0);
    expect((await runGit(['commit', '-q', '-m', 'oops'], { cwd: worktree })).exitCode).toBe(0);
    const atTip = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(atTip);
    expectError(atTip, '.env');
    expectError(atTip, 'per-task secret');
    expectOutputExcludes(atTip, NEEDLE);

    expect((await runGit(['rm', '-q', '--cached', '.env'], { cwd: worktree })).exitCode).toBe(0);
    expect((await runGit(['commit', '-q', '-m', 'remove it again'], { cwd: worktree })).exitCode).toBe(0);
    const inHistory = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(inHistory);
    expectError(inHistory, '.env');
    expectOutputExcludes(inHistory, NEEDLE);
  }, 180_000);

  // INVARIANT: deselecting a file never deletes it and never re-exposes it to
  // git. An edited, deselected secret stays in the worktree, is listed as
  // retired, and accept refuses a commit carrying it BY PATH — the bytes no
  // longer match what was delivered. An untracked file lazy did not put there
  // is refused in the push result, never overwritten.
  test('a deselected, edited secret file stays put, is reported, and cannot be accepted', async () => {
    const taskId = await createTask(ctx, 'Secret file deselected', 'Do the work');
    await rpc({ action: 'set', taskId, files: [{ path: '.env', contents: SECRET }] });
    await ctx.setClaudeScenario({
      ...successScenario({ result: 'done', sessionId: 'fake-sess-retired' }),
      steps: [
        { kind: 'commit', message: 'agent work', files: [{ path: 'work.txt', content: 'real work\n' }] },
        ...successScenario({ result: 'done', sessionId: 'fake-sess-retired' }).steps,
      ],
    });
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    const worktree = await worktreeOf(taskId);

    await writeFile(join(worktree, 'local.cfg'), 'the project\'s own untracked file\n');
    const untracked = await rpc({ action: 'set', taskId, files: [{ path: '.env', contents: SECRET }, { path: 'local.cfg', contents: SECRET }] });
    expect(untracked.delivery?.refused.map(r => r.path)).toEqual(['local.cfg']);
    expect(untracked.delivery?.refused[0].reason).toContain('untracked');
    expect(await readFile(join(worktree, 'local.cfg'), 'utf-8')).toBe('the project\'s own untracked file\n');
    // The fixture's own file, not the task's work: out of the way of accept's dirty check.
    await rm(join(worktree, 'local.cfg'));

    await writeFile(join(worktree, '.env'), 'API_TOKEN=edited-by-the-agent-0042\n');
    const cleared = await rpc({ action: 'set', taskId, files: [] });
    expect(cleared.delivery?.retired).toEqual(['.env']);
    expect(await readFile(join(worktree, '.env'), 'utf-8')).toBe('API_TOKEN=edited-by-the-agent-0042\n');
    expect((await rpc({ action: 'list', taskId })).retired).toEqual(['.env']);
    // Still excluded: lazy's own git does not see it.
    expect((await runGit(['status', '--porcelain'], { cwd: worktree })).stdout).not.toContain('.env');

    expect((await runGit(['add', '-f', '.env'], { cwd: worktree })).exitCode).toBe(0);
    expect((await runGit(['commit', '-q', '-m', 'oops'], { cwd: worktree })).exitCode).toBe(0);
    const accept = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(accept);
    expectError(accept, '.env');
    expectError(accept, 'per-task secret');
  }, 180_000);

  test('intake refuses escapes, git/lazy state and duplicates, storing nothing', async () => {
    const taskId = await createTask(ctx, 'Secret file validation', 'Do the work');
    for (const [path, re] of [
      ['../escape', /escape/],
      ['/etc/passwd', /absolute/],
      ['.git/hooks/post-checkout', /git's own state/],
      ['.lazy/config', /lazy's own state/],
      ['', /required/],
    ] as const) {
      const err = await rpc({ action: 'set', taskId, files: [{ path, contents: SECRET }] }).catch(e => e);
      expect(err).toBeInstanceOf(RpcApplicationError);
      expect((err as RpcApplicationError).status).toBe(400);
      expect((err as Error).message).toMatch(re);
      expect((err as Error).message).not.toContain(NEEDLE);
    }
    const dup = await rpc({ action: 'set', taskId, files: [{ path: '.env', contents: 'a' }, { path: '.env', contents: 'b' }] }).catch(e => e);
    expect((dup as Error).message).toMatch(/given twice/);
    expect((await rpc({ action: 'list', taskId })).paths).toEqual([]);
  }, 60_000);
});
