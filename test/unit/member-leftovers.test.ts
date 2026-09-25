/**
 * INVARIANT: a member terminal environment the previous daemon left is never
 * forgotten because the container runtime was not up when this daemon started.
 * When the leftover containers cannot be listed, every task a leftover member
 * home names is HELD — no turn, no other member — and the sweep is retried on
 * the hold's backoff until it succeeds; only then are the homes handed back
 * and the tasks released. A container left running could still be writing
 * into its task's worktree, and its home holds a member's conversation.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, realpath, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { prepareMemberHome } from '../../src/daemon/member-container';
import { sweepLeftoverMemberEnvironments, resetLeftoverSweepForTests } from '../../src/daemon/member-leftovers';
import {
  memberInsideTask,
  resetMemberTerminalsForTests,
  setMemberVacateRetryDelaysForTests,
  LEFTOVER_HOLDER,
} from '../../src/server/member-terminals';
import { pathExists } from '../../src/utils/fs';

let root: string;
let unpin: () => void;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'member-leftovers-')));
  unpin = pinDaemonBaseDir(join(root, 'daemon'));
  setMemberVacateRetryDelaysForTests([5]);
});
afterEach(async () => {
  resetMemberTerminalsForTests();
  resetLeftoverSweepForTests();
  unpin();
  await rm(root, { recursive: true, force: true });
});

const HELD = 'abcd1234-0000-0000-0000-000000000000';
const OTHER = 'ffff9999-0000-0000-0000-000000000000';

describe('the startup sweep when the container runtime is not up yet', () => {
  test("holds each task a leftover home names, retries until the runtime answers, then hands back and releases", async () => {
    const worktree = join(root, 'project', '.lazy', 'worktrees', 'held');
    await mkdir(join(worktree, '.lazy-task-sandbox'), { recursive: true });
    const home = await prepareMemberHome({
      projectRoot: join(root, 'project'), container: `lazymember-${HELD.substring(0, 8)}-a1b2c3`,
      worktreePath: worktree, agentSessionId: null, safeDirectories: [],
    });
    let listCalls = 0;
    const deps = {
      removeContainers: async () => {
        listCalls += 1;
        if (listCalls < 3) throw new Error('Cannot connect to the Docker daemon');
        return { removed: 1, failed: [] };
      },
    };
    const storage = {
      listTasks: async () => [{ id: HELD }, { id: OTHER }] as never,
      createSystemMessage: async () => ({}) as never,
    };

    await sweepLeftoverMemberEnvironments(join(root, 'project'), 'docker', storage, deps);
    expect(memberInsideTask(HELD)).toBe(LEFTOVER_HOLDER);
    expect(memberInsideTask(OTHER)).toBeNull();
    expect(await pathExists(home.dir)).toBe(true);

    for (let i = 0; i < 50 && memberInsideTask(HELD) !== null; i++) await new Promise((r) => setTimeout(r, 10));
    expect(listCalls).toBe(3);
    expect(memberInsideTask(HELD)).toBeNull();
    expect(await pathExists(home.dir)).toBe(false);
  });

  test('with no leftover home, nothing is held', async () => {
    const storage = { listTasks: async () => [{ id: HELD }] as never, createSystemMessage: async () => ({}) as never };
    await sweepLeftoverMemberEnvironments(join(root, 'project'), 'docker', storage, {
      removeContainers: async () => { throw new Error('Cannot connect to the Docker daemon'); },
    });
    expect(memberInsideTask(HELD)).toBeNull();
  });
});
