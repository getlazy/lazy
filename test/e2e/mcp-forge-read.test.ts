/**
 * `lazy_review_comments` / `lazy_review_status` through the daemon's MCP route:
 * the daemon reads the task's recorded PR/MR with its own forge credential, so
 * no token reaches the agent.
 *
 * The daemon runs in-process with the fake forge (test/mocks/remote.ts),
 * installed here with the same preload the subprocess daemons get (an
 * in-process daemon never sees `--preload`) and activated by
 * `mock-forge-writes.json`; it answers from
 * `mock-review-conversation.json` / `mock-review-status.json` and logs every
 * read to `mock-review-read-calls.jsonl`, which is how the cache is observed.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { RunningDaemon } from '../../src/daemon/server';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { findFullTaskId, setTaskMetadata } from '../helpers/storage';
import { createTask } from '../helpers/fixtures';
import { mintMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';
import { resetForgeReadCacheForTest } from '../../src/daemon/forge-read';
import { installRemoteMock } from '../mocks/remote-overlay';
import { setOfflineMode } from '../../src/utils/offline';
import { unlinkSync } from 'fs';

// Only the forge overlay: mock.module is process-wide and permanent, so the
// full preload would also mock the agent and one-shot modules for every later
// file in a multi-file run. Absent this suite's signal files it falls through
// to the real driver factory.
installRemoteMock();

const SHARED_TOKEN = 'shared-daemon-token-forge-read-test';

isolateInProcessDaemonEnv();

describe('read-only forge tools over MCP', () => {
  let ctx: TestContext;
  let daemon: RunningDaemon | undefined;
  let daemonUrl: string;
  let restoreConfig: (() => void) | undefined;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;
  let mine: string;
  let other: string;
  let mineToken: string;
  let builderToken: string;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);
    clearMcpTokenCache();
    resetForgeReadCacheForTest();

    ctx = await setupTestLazy();
    restoreConfig = pinConfig(ctx.root);
    const mineShort = await createTask(ctx, 'Has a PR');
    const otherShort = await createTask(ctx, 'Also has a PR');
    mine = findFullTaskId(ctx.root, mineShort);
    other = findFullTaskId(ctx.root, otherShort);
    for (const [short, n] of [[mineShort, '7'], [otherShort, '8']] as const) {
      setTaskMetadata(ctx.root, short, 'github_remote_ref_id', n);
      setTaskMetadata(ctx.root, short, 'github_remote_ref_url', `https://github.com/o/r/pull/${n}`);
    }
    mineToken = await mintMcpToken(ctx.root, { kind: 'task', taskId: mine }, 'lazy-forge-read');
    builderToken = await mintMcpToken(ctx.root, { kind: 'builder' }, 'builder-forge-read');

    writeForge('mock-forge-writes.json', {});
    writeForge('mock-review-conversation.json', [
      { kind: 'inline', id: '2', author: 'bo', createdAt: '2026-01-01T00:00:00Z', body: 'rename this', path: 'a.ts', line: 3, resolved: false },
    ]);
    writeForge('mock-review-status.json', {
      state: 'OPEN', decision: 'CHANGES_REQUESTED', reviews: [{ author: 'bo', state: 'CHANGES_REQUESTED', submittedAt: '' }],
      mergeable: 'BLOCKED', checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }],
    });

    const { startDaemonServer } = await import('../../src/daemon/server');
    daemon = await startDaemonServer({ token: SHARED_TOKEN, projectRoot: ctx.root });
    daemonUrl = `http://127.0.0.1:${daemon.webPort}`;
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    daemon = undefined;
    restoreConfig?.();
    clearMcpTokenCache();
    await ctx.cleanup();
    restoreDaemonBaseDir?.();
    await removeDaemonBaseDir(daemonBaseDir);
  });

  function writeForge(name: string, payload: unknown): void {
    writeFileSync(join(ctx.protocolBase, name), JSON.stringify(payload));
  }

  function forgeReads(): string[] {
    const path = join(ctx.protocolBase, 'mock-review-read-calls.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean)
      .map((l) => { const r = JSON.parse(l) as { kind: string; taskId: string }; return `${r.kind}:${r.taskId}`; });
  }

  /** Returns the tool's result, or throws with the tool's error text. */
  async function call(token: string, segment: string, tool: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const res = await fetch(`${daemonUrl}/mcp/${encodeURIComponent(segment)}/${tool}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Lazy-Project': ctx.root },
      body: JSON.stringify({ arguments: args }),
    } as any);
    const text = await res.text();
    const lines = text.trim().split('\n').filter(Boolean);
    const body = JSON.parse(lines[lines.length - 1]);
    if (body.result === undefined) throw new Error(String(body.error?.message ?? body.error ?? text));
    return body.result;
  }

  test('a task agent reads its own PR comments and status through the daemon', async () => {
    const comments = await call(mineToken, mine, 'lazy_review_comments');
    expect(comments.url).toBe('https://github.com/o/r/pull/7');
    expect(comments.data[0]).toMatchObject({ kind: 'inline', path: 'a.ts', line: 3, resolved: false, body: 'rename this' });
    const status = await call(mineToken, mine, 'lazy_review_status');
    expect(status.data).toMatchObject({ decision: 'CHANGES_REQUESTED', mergeable: 'BLOCKED' });
    expect(status.data.checks[0]).toMatchObject({ name: 'test', conclusion: 'FAILURE' });
  });

  // INVARIANT: a task agent reads only its OWN task's PR/MR — scope comes from
  // its token, and naming another task is refused before the forge is asked.
  test('a task agent is refused another task\'s PR', async () => {
    await expect(call(mineToken, mine, 'lazy_review_comments', { task: other })).rejects.toThrow(/only its own/);
    expect(forgeReads()).toEqual([]);
  });

  test('the builder may read any task\'s PR', async () => {
    const r = await call(builderToken, '_', 'lazy_review_status', { task: other });
    expect(r.url).toBe('https://github.com/o/r/pull/8');
    expect(forgeReads()).toEqual([`status:${other}`]);
  });

  // INVARIANT: a polling agent cannot burn the forge's rate limit: a repeat
  // read within the TTL is answered from the daemon's cache.
  test('a repeat read is served from cache without asking the forge again', async () => {
    const first = await call(mineToken, mine, 'lazy_review_status');
    const second = await call(mineToken, mine, 'lazy_review_status');
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(forgeReads()).toEqual([`status:${mine}`]);
  });

  // The project's own driver (no fake forge armed): the test project is on
  // the local driver, and the refusal must name that, not "no PR recorded".
  test('a project on the local driver is refused with "no forge"', async () => {
    unlinkSync(join(ctx.protocolBase, 'mock-forge-writes.json'));
    await expect(call(mineToken, mine, 'lazy_review_status')).rejects.toThrow(/local driver: there is no forge/);
  });

  test('offline, the forge is not asked and the refusal says so', async () => {
    await setOfflineMode(join(ctx.root, '.lazy'), true);
    await expect(call(mineToken, mine, 'lazy_review_comments')).rejects.toThrow(/offline/);
    expect(forgeReads()).toEqual([]);
  });
});
