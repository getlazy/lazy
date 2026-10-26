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
import { prepareMemberHome, removeLeftoverMemberContainers, memberHomesDir } from '../../src/daemon/member-container';
import { beginMemberRecovery, allowMemberBinding, memberInventoryPending, resetMemberRecoveryForTests } from '../../src/daemon/member-recovery';
import { bindTurnCredential, getTaskSessionBinding, lookupSessionBinding, clearSessionCredentialCache } from '../../src/daemon/session-credentials';
import { sweepLeftoverMemberEnvironments, resetLeftoverSweepForTests } from '../../src/daemon/member-leftovers';
import {
  membersInsideTask,
  claimMemberTerminal,
  releaseMemberTerminal,
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
  resetMemberRecoveryForTests();
  clearSessionCredentialCache();
  unpin();
  await rm(root, { recursive: true, force: true });
});

const HELD = 'abcd1234-0000-0000-0000-000000000000';
const OTHER = 'ffff9999-0000-0000-0000-000000000000';

describe('the startup sweep when the container runtime is not up yet', () => {
  // INVARIANT: an absent Docker/Podman binary is not an empty inventory.
  test('a missing runtime executable preserves the home and binding', async () => {
    const project = join(root, 'project');
    const worktree = join(project, '.lazy', 'worktrees', 'held');
    await mkdir(worktree, { recursive: true });
    const home = await prepareMemberHome({ projectRoot: project, container: `lazymember-${HELD.substring(0, 8)}-a1`, worktreePath: worktree, agentSessionId: null, safeDirectories: [] });
    const key = `member-exec:${HELD}:01`;
    const binding = await bindTurnCredential(project, { taskId: key, sessionId: 's1', ownerUserId: 'alice@example.com', kind: 'oauth' });
    beginMemberRecovery(project);
    const held: string[] = [];
    const result = await sweepLeftoverMemberEnvironments(project, 'missing-member-container-runtime', {
      listTasksStrict: async () => [{ id: HELD, status: 'blocked' }] as never,
      listTasks: async () => [{ id: HELD }] as never,
      createSystemMessage: async () => ({}) as never,
    }, { hold: task => { held.push(task); } });
    expect(result.pending).toBe(true);
    expect(held).toEqual([HELD]);
    expect(await pathExists(home.dir)).toBe(true);
    expect((await getTaskSessionBinding(project, key))?.revokedAt).toBeNull();
    expect(await lookupSessionBinding(project, binding.token)).toBeNull();
  });
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
      listTasksStrict: async () => [{ id: HELD }, { id: OTHER }] as never,
      listTasks: async () => [{ id: HELD }, { id: OTHER }] as never,
      createSystemMessage: async () => ({}) as never,
    };

    await sweepLeftoverMemberEnvironments(join(root, 'project'), 'docker', storage, deps);
    expect((membersInsideTask(HELD)[0] ?? null)).toBe(LEFTOVER_HOLDER);
    expect((membersInsideTask(OTHER)[0] ?? null)).toBeNull();
    expect(await pathExists(home.dir)).toBe(true);

    for (let i = 0; i < 50 && (membersInsideTask(HELD)[0] ?? null) !== null; i++) await new Promise((r) => setTimeout(r, 10));
    expect(listCalls).toBe(3);
    expect((membersInsideTask(HELD)[0] ?? null)).toBeNull();
    expect(await pathExists(home.dir)).toBe(false);
  });

  test('with no leftover home, nothing is held', async () => {
    const storage = { listTasks: async () => [{ id: HELD }] as never, listTasksStrict: async () => [{ id: HELD }] as never, createSystemMessage: async () => ({}) as never };
    await sweepLeftoverMemberEnvironments(join(root, 'project'), 'docker', storage, {
      removeContainers: async () => { throw new Error('Cannot connect to the Docker daemon'); },
    });
    expect((membersInsideTask(HELD)[0] ?? null)).toBeNull();
  });
});

// INVARIANT: a daemon restart keeps every member environment it can. The
// sweep re-adopts a running or stopped container whose credential is still live — its
// home kept, its hold rebuilt, its credential returned so the startup revoke
// leaves it alone — and removes the rest exactly as before, including any
// whose task is gone or finished.
describe('the startup sweep re-adopts what it can', () => {
  // INVARIANT: a reconnect claims before its pending-recovery refusal. That
  // temporary claim is not a duplicate environment authorizing deletion.
  test('recovery racing a terminal claim keeps the environment and retries adoption', async () => {
    const project = join(root, 'project');
    const worktree = join(project, '.lazy', 'worktrees', 'held');
    await mkdir(worktree, { recursive: true });
    const name = `lazymember-${HELD.substring(0, 8)}-a1`;
    const home = await prepareMemberHome({ projectRoot: project, container: name, worktreePath: worktree, agentSessionId: null, safeDirectories: [] });
    let retry: (() => Promise<void>) | undefined;
    const removed: string[] = [];
    expect(claimMemberTerminal(HELD, 'alice@example.com').ok).toBe(true);
    const result = await sweepLeftoverMemberEnvironments(project, 'docker', {
      listTasksStrict: async () => [{ id: HELD, status: 'blocked' }] as never,
      listTasks: async () => [{ id: HELD }] as never,
      createSystemMessage: async () => ({}) as never,
    }, {
      hold: (_task, again) => { retry = again; },
      removeContainers: (p, b, d) => removeLeftoverMemberContainers(p, b, {
        ...d, list: async () => `${name}\t${HELD}\talice@example.com\tmember-exec:${HELD}:01\texited`,
        remove: async (_b, n) => { removed.push(n); },
      }),
      readopt: async () => ({ ok: true, waitForAttach: true, email: 'alice@example.com', bindingKey: `member-exec:${HELD}:01`, grantLabel: `member-terminal:alice@example.com:${name}`, container: { name, binary: 'docker', remove: async () => {} } }),
    });
    expect(result.pending).toBe(true);
    expect(removed).toEqual([]);
    expect(await pathExists(home.dir)).toBe(true);
    releaseMemberTerminal(HELD, 'alice@example.com');
    await retry!();
    expect(removed).toEqual([]);
    expect(membersInsideTask(HELD)).toEqual(['alice@example.com']);
  });
  // INVARIANT: a partial sweep must never turn an operational failure into
  // deletion or revoke credentials it could not yet classify. Retrying also
  // recognizes environments that were already adopted before the failure.
  test('a partial recovery preserves homes and credentials and retries without deleting an adopted environment', async () => {
    const project = join(root, 'project');
    const worktree = join(project, '.lazy', 'worktrees', 'held');
    await mkdir(worktree, { recursive: true });
    const names = [`lazymember-${HELD.substring(0, 8)}-a1`, `lazymember-${OTHER.substring(0, 8)}-b2`];
    const keys = [`member-exec:${HELD}:01`, `member-exec:${OTHER}:02`];
    const bindings = [];
    for (let i = 0; i < 2; i++) {
      await prepareMemberHome({ projectRoot: project, container: names[i]!, worktreePath: worktree, agentSessionId: null, safeDirectories: [] });
      bindings.push(await bindTurnCredential(project, { taskId: keys[i]!, sessionId: 's1', ownerUserId: 'alice@example.com', kind: 'oauth' }));
    }
    beginMemberRecovery(project);
    let fail = true;
    let retry: (() => Promise<void>) | undefined;
    const removed: string[] = [];
    const result = await sweepLeftoverMemberEnvironments(project, 'docker', {
      listTasksStrict: async () => [{ id: HELD, status: 'blocked' }, { id: OTHER, status: 'blocked' }] as never,
      listTasks: async () => [{ id: HELD }, { id: OTHER }] as never,
      createSystemMessage: async () => ({}) as never,
    }, {
      hold: (_task, again) => { retry = again; },
      removeContainers: (p, b, d) => removeLeftoverMemberContainers(p, b, {
        ...d,
        list: async () => names.map((n, i) => `${n}\t${[HELD, OTHER][i]}\talice@example.com\t${keys[i]}\trunning`).join('\n'),
        remove: async (_b, n) => { removed.push(n); },
      }),
      readopt: async ({ leftover }) => {
        if (fail && leftover.taskId === OTHER) throw new Error('container inspection unavailable');
        allowMemberBinding(project, leftover.bindingKey!);
        return { ok: true, waitForAttach: true, email: leftover.email!, bindingKey: leftover.bindingKey!, grantLabel: `member-terminal:${leftover.email}:${leftover.name}`, container: { name: leftover.name, binary: 'docker', remove: async () => {} } };
      },
    });
    expect(result.pending).toBe(true);
    expect(memberInventoryPending(project)).toBe(true);
    expect(removed).toEqual([]);
    for (const key of keys) expect((await getTaskSessionBinding(project, key))?.revokedAt).toBeNull();
    expect(await lookupSessionBinding(project, bindings[1]!.token)).toBeNull();
    for (const name of names) expect(await pathExists(join(memberHomesDir(project), name))).toBe(true);
    expect(membersInsideTask(HELD)).toEqual(['alice@example.com']);
    fail = false;
    expect(retry).toBeDefined();
    await retry!();
    expect(memberInventoryPending(project)).toBe(false);
    expect(removed).toEqual([]);
    expect(membersInsideTask(HELD)).toEqual(['alice@example.com']);
    expect(membersInsideTask(OTHER)).toEqual(['alice@example.com']);
    for (const binding of bindings) expect(await lookupSessionBinding(project, binding.token)).not.toBeNull();
  });
  for (const state of ['running', 'exited']) {
    test(`keeps a re-adoptable ${state} environment and removes the others`, async () => {
      const project = join(root, 'project');
      const worktree = join(project, '.lazy', 'worktrees', 'held');
      await mkdir(join(worktree, '.lazy-task-sandbox'), { recursive: true });
      const keptName = `lazymember-${HELD.substring(0, 8)}-a1`;
      const goneName = `lazymember-${OTHER.substring(0, 8)}-b2`;
      const keptHome = await prepareMemberHome({ projectRoot: project, container: keptName, worktreePath: worktree, agentSessionId: null, safeDirectories: [] });
      const goneHome = await prepareMemberHome({ projectRoot: project, container: goneName, worktreePath: worktree, agentSessionId: null, safeDirectories: [] });
      const removed: string[] = [];
      const readoptAsked: string[] = [];
      const kept = await sweepLeftoverMemberEnvironments(project, 'docker', {
        listTasksStrict: async () => [{ id: HELD, status: 'working' }, { id: OTHER, status: 'complete' }] as never,
        listTasks: async () => [{ id: HELD }, { id: OTHER }] as never,
        createSystemMessage: async () => ({}) as never,
      }, {
        removeContainers: (p, b, d) => removeLeftoverMemberContainers(p, b, {
          ...d,
          list: async () => `${keptName}\t${HELD}\talice@example.com\tmember-exec:${HELD}:01\t${state}\n${goneName}\t${OTHER}\tbob@example.com\tmember-exec:${OTHER}:02\t${state}\n`,
          remove: async (_b, n) => { removed.push(n); },
        }),
        readopt: async ({ leftover }) => {
          readoptAsked.push(leftover.name);
          return {
            ok: true, waitForAttach: !leftover.running, email: leftover.email!, bindingKey: leftover.bindingKey!, grantLabel: `member-terminal:${leftover.email}:${leftover.name}`,
            container: { name: leftover.name, binary: 'docker', remove: async () => {} },
          };
        },
      });
      // The finished task's container is never even offered for re-adoption.
      expect(readoptAsked).toEqual([keptName]);
      expect(removed).toEqual([goneName]);
      expect([...kept.bindingKeys]).toEqual([`member-exec:${HELD}:01`]);
      expect([...kept.grantLabels]).toEqual([`member-terminal:alice@example.com:${keptName}`]);
      expect(membersInsideTask(HELD)).toEqual(['alice@example.com']);
      expect(await pathExists(keptHome.dir)).toBe(true);
      expect(await pathExists(goneHome.dir)).toBe(false);
    });
  }

  // INVARIANT: an unreadable task store is not evidence a member's task is gone.
  test('never offers containers for deletion when task ownership cannot be read', async () => {
    let removals = 0;
    await sweepLeftoverMemberEnvironments(root, 'docker', {
      listTasksStrict: async () => { throw new Error('task record is corrupt'); },
      listTasks: async () => [],
      createSystemMessage: async () => ({}) as never,
    }, { removeContainers: async () => { removals++; return { removed: 1, failed: [] }; } });
    expect(removals).toBe(0);
  });
});
