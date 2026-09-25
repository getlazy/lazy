/**
 * Daemon linkTask: validate git names at the boundary, leave no half-linked
 * row when a later step fails, and warn when the local branch is not a
 * fast-forward of origin.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDaemonStorage, getOrCreateStorage, closeAllStorage } from '../../src/daemon/rpc-handlers';
import { linkTask } from '../../src/daemon/link-task';
import { describeLinkedTask } from '../../src/daemon/link-describe';
import { syncTask } from '../../src/daemon/task-lifecycle';
import { RpcError } from '../../src/daemon/rpc-error';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { IMPORT_SOURCE_BRANCH_KEY } from '../../src/task/linked';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { putUserCredential, clearUserCredentialCache } from '../../src/daemon/user-credentials';
import { NO_OWNER_CREDENTIAL_MARKER } from '../../src/daemon/turn-credentials';

function git(cwd: string, ...args: string[]): void {
  const result = spawnSyncUnsupervised(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
}

describe('daemon linkTask', () => {
  let root: string;
  let bare: string;
  let prevLazyConfig: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-linktask-'));
    bare = await mkdtemp(join(tmpdir(), 'lazy-linktask-bare-'));
    const store = join(root, 'store');
    await mkdir(store, { recursive: true });
    await writeFile(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${store}"\n\n[remote]\ndriver = "local"\n`,
    );

    git(root, 'init');
    git(root, 'config', 'user.email', 'test@lazy.test');
    git(root, 'config', 'user.name', 'Lazy Test');
    git(root, 'checkout', '-b', 'main');
    await writeFile(join(root, 'README.md'), '# link\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'Initial commit');
    spawnSyncUnsupervised(['git', 'init', '--bare'], { cwd: bare });
    git(root, 'remote', 'add', 'origin', bare);

    prevLazyConfig = process.env.LAZY_CONFIG;
    process.env.LAZY_CONFIG = join(root, 'lazy.toml');
    initDaemonStorage(root);
  });

  afterEach(async () => {
    await closeAllStorage();
    if (prevLazyConfig === undefined) delete process.env.LAZY_CONFIG;
    else process.env.LAZY_CONFIG = prevLazyConfig;
    await rm(root, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  });

  // INVARIANT: a branch or remote that git would parse as an option is
  // refused at the boundary with 400, and no task row is written.
  test('refuses --upload-pack-style branch names with 400 and creates no task', async () => {
    const storage = await getOrCreateStorage();
    const before = await storage.listTasks();

    let err: unknown;
    try {
      await linkTask(root, { ref: '--upload-pack=evil', actor: 'human' });
    } catch (caught) {
      err = caught;
    }

    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).status).toBe(400);
    expect((err as RpcError).message).toMatch(/starting with '-'/);
    expect(await storage.listTasks()).toEqual(before);
  });

  test('refuses --upload-pack-style remote names with 400 and creates no task', async () => {
    const storage = await getOrCreateStorage();
    const before = await storage.listTasks();

    let err: unknown;
    try {
      await linkTask(root, { ref: '--upload-pack=evil/feature', actor: 'human' });
    } catch (caught) {
      err = caught;
    }

    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).status).toBe(400);
    expect((err as RpcError).message).toMatch(/starting with '-'/);
    expect(await storage.listTasks()).toEqual(before);
  });

  // INVARIANT: if createTask succeeds and a later git step throws, the
  // leftover is closed with a reason naming the failure — not left in backlog.
  test('closes the leftover task when worktree creation fails after createTask', async () => {
    const branch = 'feature/half-link';
    git(root, 'checkout', '-b', branch);
    git(root, 'commit', '--allow-empty', '-m', 'on branch');
    git(root, 'push', 'origin', branch);
    git(root, 'checkout', 'main');

    await mkdir(join(root, '.lazy'), { recursive: true });
    await writeFile(join(root, '.lazy', 'worktrees'), 'not-a-directory\n');

    const storage = await getOrCreateStorage();
    let err: unknown;
    try {
      await linkTask(root, { ref: branch, code: 'half-link', actor: 'human' });
    } catch (caught) {
      err = caught;
    }

    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).status).toBe(500);
    expect((err as RpcError).message).toMatch(/Link failed after creating task/);
    expect((err as RpcError).message).toMatch(/Closed leftover task/);

    const leftover = await storage.resolveTask('half-link');
    expect(leftover.task).not.toBeNull();
    expect(leftover.task?.status).toBe('abandoned');
    expect(leftover.task?.close_reason ?? '').toMatch(/link failed/i);
  });

  // INVARIANT: when the local branch is not a fast-forward of origin we
  // still adopt the local branch, but we warn with commit counts.
  test('warns when the local branch differs from origin', async () => {
    const branch = 'feature/diverged';
    git(root, 'checkout', '-b', branch);
    git(root, 'commit', '--allow-empty', '-m', 'shared');
    git(root, 'push', 'origin', branch);
    git(root, 'commit', '--allow-empty', '-m', 'local-only');
    git(root, 'checkout', 'main');

    const result = await linkTask(root, { ref: branch, code: 'diverged', actor: 'human' });
    expect(result.status).toBe('blocked');
    expect(result.branch).toBe(branch);
    expect(result.warnings.some((w) => /differs from 'origin\/feature\/diverged'/.test(w))).toBe(true);
    expect(result.warnings.some((w) => /1 local-only commit/.test(w))).toBe(true);
    expect(result.warnings.some((w) => /1 local-only commit/.test(w))).toBe(true);
    expect(result.warnings.some((w) => /tracks the local branch/.test(w))).toBe(true);
  });

  // INVARIANT: an agent cannot sync a linked task (that merges into someone
  // else's branch). A human still can — they hit the usual session check.
  test('agent sync of a linked task is refused; human is not', async () => {
    const storage = await getOrCreateStorage();
    const created = await storage.createTask(
      'linked child',
      undefined,
      undefined,
      'linked-child',
      undefined,
      'claude-code',
      'human',
    );
    await storage.updateTaskMetadata(created.id, IMPORT_SOURCE_BRANCH_KEY, 'feature/theirs');
    await storage.updateTaskStatus(created.id, 'blocked', 'human');

    let agentErr: unknown;
    try {
      await syncTask(root, { taskId: created.id, actor: 'agent' });
    } catch (caught) {
      agentErr = caught;
    }
    expect(agentErr).toBeInstanceOf(RpcError);
    expect((agentErr as RpcError).status).toBe(403);
    expect((agentErr as RpcError).message).toMatch(/cannot sync a linked task/);

    let humanErr: unknown;
    try {
      await syncTask(root, { taskId: created.id, actor: 'human' });
    } catch (caught) {
      humanErr = caught;
    }
    expect(humanErr).toBeInstanceOf(RpcError);
    expect((humanErr as RpcError).status).toBe(400);
    expect((humanErr as RpcError).message).toMatch(/no session/);
  });

  // INVARIANT: in team mode a link is billed to the human who asked, with no
  // fallback — a member with no credential of their own is refused BEFORE any
  // task is adopted, rather than linked on the builder's or anyone else's account.
  test('team mode: a member without a credential is refused and nothing is linked', async () => {
    const base = await mkdtemp(join(tmpdir(), 'lazy-linktask-cred-'));
    const unpin = pinDaemonBaseDir(base);
    clearUserCredentialCache();
    try {
      await putUserCredential(root, { userId: 'alice@example.com', kind: 'api-key', token: 'sk-ant-api-alice' });
      git(root, 'checkout', '-b', 'feature/bob');
      git(root, 'checkout', 'main');
      const storage = await getOrCreateStorage();
      const before = await storage.listTasks();

      let err: unknown;
      try {
        await linkTask(root, { ref: 'feature/bob', actor: { role: 'human', email: 'bob@example.com' } });
      } catch (caught) {
        err = caught;
      }
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).status).toBe(400);
      expect((err as RpcError).message).toContain(NO_OWNER_CREDENTIAL_MARKER);
      expect(await storage.listTasks()).toEqual(before);
    } finally {
      unpin();
      clearUserCredentialCache();
      await rm(base, { recursive: true, force: true });
    }
  });

  // INVARIANT: `lazy describe` is held to the same rule as a link — in team
  // mode a member with no credential of their own is refused, never run on the
  // builder's account.
  test('team mode: describe refuses a member without a credential', async () => {
    git(root, 'checkout', '-b', 'feature/desc');
    git(root, 'checkout', 'main');
    const linked = await linkTask(root, { ref: 'feature/desc', actor: 'human' });

    const base = await mkdtemp(join(tmpdir(), 'lazy-linktask-desc-'));
    const unpin = pinDaemonBaseDir(base);
    clearUserCredentialCache();
    try {
      await putUserCredential(root, { userId: 'alice@example.com', kind: 'api-key', token: 'sk-ant-api-alice' });
      let err: unknown;
      try {
        await describeLinkedTask(root, { taskId: linked.taskId, force: true, actor: { role: 'human', email: 'bob@example.com' } });
      } catch (caught) {
        err = caught;
      }
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).message).toContain(NO_OWNER_CREDENTIAL_MARKER);
    } finally {
      unpin();
      clearUserCredentialCache();
      await rm(base, { recursive: true, force: true });
    }
  });
});
