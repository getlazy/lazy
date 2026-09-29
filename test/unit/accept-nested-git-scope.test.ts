import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { nestedGitScanApplies, refuseNestedGitOnAccept } from '../../src/daemon/task-lifecycle';
import type { Storage } from '../../src/storage';
import { RpcError } from '../../src/daemon/rpc-error';
import type { Task } from '../../src/types';

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), 'nested-scope-')));
  dirs.push(d);
  return d;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

describe('accept nested-git gate scope', () => {
  // INVARIANT: a project root with no .git is not a layout lazy creates task
  // worktrees in, so accept skips the nested-repository scan there instead of
  // failing closed — otherwise the scan's ENOENT masks every other accept refusal.
  test('skipped for a project root without .git', async () => {
    const root = await tmp();
    const wt = join(root, '.lazy', 'worktrees', 't');
    await mkdir(wt, { recursive: true });
    expect(await nestedGitScanApplies(root, wt)).toBe(false);
  });

  test('skipped when the worktree does not exist', async () => {
    const root = await tmp();
    await mkdir(join(root, '.git'));
    expect(await nestedGitScanApplies(root, join(root, '.lazy', 'worktrees', 'gone'))).toBe(false);
  });

  // INVARIANT: inside a real task worktree (root has .git, as a dir or a gitdir
  // file) the scan runs, so a scan that throws there still refuses the accept.
  test('applies inside a real task worktree (.git dir or gitdir file)', async () => {
    const root = await tmp();
    const wt = join(root, '.lazy', 'worktrees', 't');
    await mkdir(wt, { recursive: true });
    await mkdir(join(root, '.git'));
    expect(await nestedGitScanApplies(root, wt)).toBe(true);

    const root2 = await tmp();
    const wt2 = join(root2, '.lazy', 'worktrees', 't');
    await mkdir(wt2, { recursive: true });
    await writeFile(join(root2, '.git'), 'gitdir: /elsewhere\n');
    expect(await nestedGitScanApplies(root2, wt2)).toBe(true);
  });
});

describe('accept nested-git gate refusal', () => {
  const task = { id: 'nested-scope-task', code: 'nested-scope-task', goal: 'g', status: 'blocked' } as unknown as Task;
  const storage = {} as unknown as Storage;

  async function plantNested(wt: string): Promise<void> {
    await mkdir(join(wt, 'sub', '.git'), { recursive: true });
    await writeFile(join(wt, 'sub', '.git', 'config'), '[core]\n\tfsmonitor = /tmp/payload.sh\n');
    await writeFile(join(wt, 'sub', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  }

  // INVARIANT: with no .git at the project root the gate is skipped entirely —
  // it resolves without refusing, so every other accept refusal stays visible.
  test('skipped (no refusal) for a root without .git', async () => {
    const root = await tmp();
    const wt = join(root, '.lazy', 'worktrees', 't');
    await plantNested(wt);
    await refuseNestedGitOnAccept(root, storage, task, wt);
  });

  // INVARIANT: inside a real task worktree a scan that cannot answer REFUSES
  // the accept (fail closed) — never a silent pass.
  test('refuses when the scan fails inside a real task worktree', async () => {
    const root = await tmp();
    const wt = join(root, '.lazy', 'worktrees', 't');
    await plantNested(wt);
    await writeFile(join(root, '.git'), `gitdir: ${join(root, 'does-not-exist')}\n`);
    let caught: unknown;
    try {
      await refuseNestedGitOnAccept(root, storage, task, wt);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RpcError);
    expect((caught as RpcError).status).toBe(409);
    expect((caught as Error).message).toContain('could not be checked for nested git repositories');
  });
});
