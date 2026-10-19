/**
 * Teams' way out of a failing Dockerfile.lazy, over the wire: the daemon's
 * adoption RPCs (src/daemon/image-adoption.ts) and the gating of the
 * `lazy_image_build` try-build tool (src/daemon/image-try-build.ts), against a
 * real daemon on its TCP port — the surface Rails and the agents use. The
 * build itself runs against a fake docker in test/unit/image-recovery.test.ts.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readdirSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { mintMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';
import { writeDaemonMcpConfig } from '../../src/daemon/task-launcher';
import { setDaemonContext, clearDaemonContext, hasDaemonContext } from '../../src/daemon/context';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';
import { createTask } from '../helpers/fixtures';
import { setTaskStatus, tasksDirFor } from '../helpers/storage';
import { runGit } from '../../src/utils/git';

const TOKEN = 'test-token-image-recovery';
const BROKEN = 'FROM alpine:3.20\nRUN exit 1\n';
const WORKING = 'FROM alpine:3.20\nRUN true\n';

isolateInProcessDaemonEnv();

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runGit(args, { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

describe('image recovery over RPC', () => {
  let ctx: TestContext;
  let daemon: RunningDaemon | undefined;
  let restoreConfig: (() => void) | undefined;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;
  let mainBranch: string;
  let fixCommit: string;
  /** Created BEFORE the in-process daemon starts: it holds the storage lock. */
  let taskShortId: string;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);
    clearMcpTokenCache();
    ctx = await setupTestLazy();
    restoreConfig = pinConfig(ctx.root);

    mainBranch = await git(ctx.root, 'symbolic-ref', '--short', 'HEAD');
    await writeFile(join(ctx.root, 'Dockerfile.lazy'), BROKEN);
    await git(ctx.root, 'add', 'Dockerfile.lazy');
    await git(ctx.root, 'commit', '-q', '-m', 'a Dockerfile.lazy that does not build');
    await git(ctx.root, 'branch', 'fix-image');
    await git(ctx.root, 'checkout', '-q', 'fix-image');
    await writeFile(join(ctx.root, 'Dockerfile.lazy'), WORKING);
    await git(ctx.root, 'commit', '-q', '-am', 'a Dockerfile.lazy that builds');
    fixCommit = await git(ctx.root, 'rev-parse', 'HEAD');
    await git(ctx.root, 'checkout', '-q', mainBranch);
    taskShortId = await createTask(ctx, 'fix the image');

    daemon = await startDaemonServer({ token: TOKEN, projectRoot: ctx.root });
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    daemon = undefined;
    restoreConfig?.();
    restoreConfig = undefined;
    clearMcpTokenCache();
    await ctx.cleanup();
    restoreDaemonBaseDir?.();
    restoreDaemonBaseDir = undefined;
    await removeDaemonBaseDir(daemonBaseDir);
  });

  async function rpc(command: string, params: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
    const resp = await fetch(`http://127.0.0.1:${daemon!.webPort}/rpc/${command}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}`, 'X-Lazy-Project': ctx.root },
      body: JSON.stringify(params),
    });
    return { status: resp.status, body: await resp.json() };
  }

  test('the preview shows the branch\'s committed Dockerfile.lazy next to the project branch\'s', async () => {
    const { status, body } = await rpc('imageAdoptionPreview', { ref: 'fix-image' });
    expect(status).toBe(200);
    expect(body.candidate.content).toBe(WORKING);
    expect(body.candidate.commit).toBe(fixCommit);
    expect(body.candidate.dockerfile).toBe('Dockerfile.lazy');
    expect(body.main.branch).toBe(mainBranch);
    expect(body.main.content).toBe(BROKEN);
  });

  test('a task names its branch', async () => {
    const { status, body } = await rpc('imageAdoptionPreview', { ref: taskShortId });
    // The task has no commits of its own yet: its branch is named, and refused
    // as having nothing to adopt — never silently read from somewhere else.
    expect([404]).toContain(status);
    expect(JSON.stringify(body)).toContain('lazy/');
  });

  test('an unknown branch is a 404', async () => {
    const { status } = await rpc('imageAdoptionPreview', { ref: 'no-such-branch' });
    expect(status).toBe(404);
  });

  // INVARIANT: an adoption is bound to the commit and file the admin was shown.
  test('adopting something other than what was shown is refused', async () => {
    const preview = await rpc('imageAdoptionPreview', { ref: 'fix-image' });
    const stale = await rpc('adoptImageFromRef', { ref: 'fix-image', commit: '0'.repeat(40), contentHash: preview.body.candidate.contentHash });
    expect(stale.status).toBe(409);
    const changed = await rpc('adoptImageFromRef', { ref: 'fix-image', commit: fixCommit, contentHash: 'f'.repeat(64) });
    expect(changed.status).toBe(409);
    const status = await rpc('runnerImage');
    expect(status.body.adoption).toBeNull();
    expect(status.body.adoptionBuild.state).toBe('none');
  });

  test('switching back with no adoption in force changes nothing', async () => {
    const { status, body } = await rpc('clearImageAdoption');
    expect(status).toBe(200);
    expect(body.cleared).toBe(false);
  });

  // INVARIANT: lazy_image_build is refused anywhere but a managed microVM
  // daemon — here an unmanaged one, and one told it is on local docker.
  test('lazy_image_build is refused by an unmanaged or local-docker daemon', async () => {
    const fullId = readdirSync(tasksDirFor(ctx.root)).find((e) => e.startsWith(taskShortId))!;
    const token = await mintMcpToken(ctx.root, { kind: 'task', taskId: fullId }, 'e2e-agent');
    // Mid-turn, so the refusal below is the backend's: a task's token acts only
    // for the turn that is running.
    setTaskStatus(ctx.root, taskShortId, 'working');
    const call = async () => {
      const resp = await fetch(`http://127.0.0.1:${daemon!.webPort}/mcp/${fullId}/lazy_image_build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'X-Lazy-Project': ctx.root },
        body: JSON.stringify({ arguments: {} }),
      } as any);
      return resp.text();
    };
    expect(await call()).toContain('only available on Lazy Teams projects that run on a microVM');

    const saved = { m: process.env.LAZY_MANAGED, b: process.env.LAZY_MANAGED_BACKEND };
    // A MANAGED daemon on the local-docker backend (the host's shared dockerd).
    process.env.LAZY_MANAGED = '1';
    process.env.LAZY_MANAGED_BACKEND = 'local-docker';
    try {
      expect(await call()).toContain('only available on Lazy Teams projects that run on a microVM');
    } finally {
      if (saved.m === undefined) delete process.env.LAZY_MANAGED; else process.env.LAZY_MANAGED = saved.m;
      if (saved.b === undefined) delete process.env.LAZY_MANAGED_BACKEND; else process.env.LAZY_MANAGED_BACKEND = saved.b;
    }
  });

  // INVARIANT: the capability is granted in a task's MCP config only by a
  // managed microVM daemon, and never to the builder.
  test('the image-build capability is written only for a task on a managed microVM daemon', async () => {
    const read = async (p: string) => JSON.parse(await readFile(p, 'utf-8'));
    const hadContext = hasDaemonContext();
    if (!hadContext) setDaemonContext({ webPort: daemon!.webPort, token: TOKEN });
    expect((await read(await writeDaemonMcpConfig(ctx.root, 'c-unmanaged', { kind: 'task', taskId: 'x' }))).capabilities).toBeUndefined();

    const saved = { m: process.env.LAZY_MANAGED, b: process.env.LAZY_MANAGED_BACKEND };
    process.env.LAZY_MANAGED = '1';
    process.env.LAZY_MANAGED_BACKEND = 'microvm';
    try {
      expect((await read(await writeDaemonMcpConfig(ctx.root, 'c-task', { kind: 'task', taskId: 'x' }))).capabilities).toEqual(['image-build']);
      expect((await read(await writeDaemonMcpConfig(ctx.root, 'c-builder', { kind: 'builder' }))).capabilities).toBeUndefined();
      process.env.LAZY_MANAGED_BACKEND = 'local-docker';
      expect((await read(await writeDaemonMcpConfig(ctx.root, 'c-local', { kind: 'task', taskId: 'x' }))).capabilities).toBeUndefined();
    } finally {
      if (saved.m === undefined) delete process.env.LAZY_MANAGED; else process.env.LAZY_MANAGED = saved.m;
      if (saved.b === undefined) delete process.env.LAZY_MANAGED_BACKEND; else process.env.LAZY_MANAGED_BACKEND = saved.b;
      if (!hadContext) clearDaemonContext();
    }
  });
});
