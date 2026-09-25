/**
 * A web Pair's end records the commits made during it, exactly as `lazy
 * pair`'s end-of-session record does (src/server/shell-pair.ts `releasePair`).
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { planPairOrChatExec, resetWebPairStateForTests } from '../../src/server/shell-pair';
import { getWorktreePath } from '../../src/task/identity';
import { checkPairingLock } from '../../src/utils/pairing-lock';
import type { Storage } from '../../src/storage';
import type { Session, Task } from '../../src/types';

let root: string | null = null;
let prevLazyTest: string | undefined;

afterEach(async () => {
  resetWebPairStateForTests();
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
  if (prevLazyTest === undefined) delete process.env.LAZY_TEST;
  else process.env.LAZY_TEST = prevLazyTest;
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`git ${args.join(' ')}: ${await new Response(p.stderr).text()}`);
  return out.trim();
}

/** A blocked task with a real git worktree and a store that records what the release writes. */
async function pairOnFreshRepo() {
  prevLazyTest = process.env.LAZY_TEST;
  process.env.LAZY_TEST = '1';
  root = await realpath(await mkdtemp(join(tmpdir(), 'pair-commits-')));
  const task = { id: 'task-c', code: 'democ', status: 'blocked', agent_id: 'claude-code', metadata: { task_ref: 'democ' } } as unknown as Task;
  const wt = getWorktreePath(root, task);
  await mkdir(wt, { recursive: true });
  await git(wt, 'init', '-q');
  await git(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
  const startSha = await git(wt, 'rev-parse', 'HEAD');

  const session = { id: 'sess-c', task_id: 'task-c', runner_type: 'docker', git_start_sha: startSha } as unknown as Session;
  const recorded: Array<{ sha: string; message: string }> = [];
  const turns: string[] = [];
  const state = { status: 'blocked' };
  const storage = {
    updateTaskStatus: async (_id: string, s: string) => { state.status = s; },
    updateTaskMetadata: async () => {},
    getSessionByTaskId: async () => session,
    getNextTurnSequence: async () => 1,
    createTurn: async (t: { content: string }) => { turns.push(t.content); },
    getSessionCommits: async () => recorded,
    createCommit: async (_sid: string, sha: string, message: string) => { recorded.push({ sha, message }); },
    getProjectSettings: async () => null,
    getTask: async () => ({ ...task, status: state.status }),
    getSessionTurns: async () => [],
  } as unknown as Storage;

  const planned = await planPairOrChatExec({ root, storage, task, session, mode: 'pair' });
  if (!planned.ok) throw new Error(`pair was refused: ${planned.message}`);
  expect(state.status).toBe('pairing');
  expect(checkPairingLock(wt)).not.toBeNull();
  return { wt, plan: planned.plan, recorded, turns, state };
}

/** The release runs in the background and spawns git; wait for its turn row. */
async function untilTurn(turns: string[]): Promise<void> {
  const deadline = Date.now() + 5000;
  while (turns.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}

describe('web Pair end', () => {
  // INVARIANT: ending a web Pair records the commits the pairing made, through
  // the same resolver as `lazy pair` — otherwise the work done while paired
  // is missing from the task's commits until some later turn happens to
  // record it, and the "session ended" turn names nothing that was done.
  test('records the commits made while paired, then clears the lock', async () => {
    const { wt, plan, recorded, turns, state } = await pairOnFreshRepo();

    // The human commits while paired.
    await writeFile(join(wt, 'paired.txt'), 'hi\n');
    await git(wt, 'add', 'paired.txt');
    await git(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'made while pairing');

    plan.abort();
    await untilTurn(turns);

    expect(recorded.map((c) => c.message)).toEqual(['made while pairing']);
    expect(turns.at(-1)).toContain('made while pairing');
    expect(state.status).not.toBe('pairing');
    expect(checkPairingLock(wt)).toBeNull();
  });

  test('a Pair that made no commits ends with the plain turn', async () => {
    const { wt, plan, recorded, turns, state } = await pairOnFreshRepo();

    plan.abort();
    await untilTurn(turns);

    expect(recorded).toEqual([]);
    expect(turns).toEqual(['[pairing session]\n\nWeb pairing session ended.']);
    expect(state.status).not.toBe('pairing');
    expect(checkPairingLock(wt)).toBeNull();
  });
});
