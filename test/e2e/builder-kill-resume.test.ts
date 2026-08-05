/**
 * The killed-builder resume path, end to end through the REAL supervisor.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * `lazy upgrade` stops a live builder and relaunches it into the same terminal;
 * the relaunched child must come back into the SAME conversation. It did not.
 * The session id was only produced by the in-container supervisor's exit path,
 * and upgrade killed the container with SIGKILL — so nothing was stamped onto
 * the resume intent and the relaunch loop resumed whatever conversation happened
 * to be newest in the project (task `fix-upgrade-relaunch-resume`).
 *
 * Both halves of the fix are exercised here against a real `lazy-agent builder`
 * supervisor process and a fake `claude` writing real session JSONL (same seam
 * as builder-live-capture.test.ts; only the agent binary and the container
 * boundary are fake):
 *
 *   1. SIGTERM — what `docker stop --time` now delivers — must stamp the intent.
 *   2. SIGKILL — what `docker kill` delivered, and what an OOM or a crash still
 *      delivers — stamps nothing, and the HOST must recover the id anyway.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { installFakeAgentBinary } from '../helpers/fake-agent-binary';
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { getTokenPath, getWebPortPath } from '../../src/daemon/paths';
import { DaemonClient } from '../../src/daemon/client';
import { RemoteStorage } from '../../src/storage/remote-storage';
import { encodeProjectPath } from '../../src/import/claude-code-logs';
import { detectBuilderLaunchSessionId } from '../../src/builder/session-detect';
import type { BuilderResumeIntent } from '../../src/storage/types';

const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');
const BUILDER_ID = 'testbuilder';

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('builder killed mid-session → resumable', () => {
  let ctx: TestContext;
  let home: string;
  let binDir: string;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
    home = await mkdtemp(join(tmpdir(), 'lazy-e2e-home-'));
    await mkdir(join(home, '.claude', 'projects'), { recursive: true });
    binDir = await mkdtemp(join(tmpdir(), 'lazy-e2e-bin-'));
    await installFakeAgentBinary(binDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(home, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  });

  /**
   * Read/write intents through the DAEMON, not a second FileStorage — the
   * daemon holds `.storage-lock`, and the supervisor writes through this same
   * surface, so this is also what production reads back.
   */
  async function daemonStorage(): Promise<RemoteStorage> {
    const client = DaemonClient.create(ctx.root);
    if (!client) throw new Error('no daemon client for the test project');
    const storagePath = await client.rpc('storage', ctx.root, {
      method: 'getStoragePath',
      args: {},
    }) as string;
    return new RemoteStorage(client, ctx.root, storagePath);
  }

  /** Write the daemon MCP config the supervisor reads (as the runner mounts it). */
  async function writeDaemonConfig(): Promise<string> {
    const token = (await readFile(getTokenPath(ctx.root), 'utf-8')).trim();
    const port = (await readFile(getWebPortPath(ctx.root), 'utf-8')).trim();
    const path = join(ctx.root, '.lazy', 'tmp', 'daemon-mcp-builder-kill.json');
    await mkdir(join(ctx.root, '.lazy', 'tmp'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ token, projectRoot: ctx.root, taskId: '', target: `http://127.0.0.1:${port}` }, null, 2),
    );
    return path;
  }

  /** Start the real builder supervisor in the background. */
  async function startSupervisor(daemonConfigPath: string) {
    const promptFile = join(ctx.root, '.lazy', 'tmp', 'builder-prompt.txt');
    await writeFile(promptFile, 'You are the builder.');
    const builderConfigPath = join(ctx.root, '.lazy', 'tmp', 'builder-cfg.json');
    await writeFile(
      builderConfigPath,
      JSON.stringify({ host: '127.0.0.1', port: 1, token: 'unused', lazyRoot: ctx.root }),
    );
    return Bun.spawn(
      [
        'bun', 'run', AGENT_ENTRY, 'builder',
        '--system-prompt-file', promptFile,
        '--worktree', ctx.root,
        '--builder-config', builderConfigPath,
        '--daemon-config', daemonConfigPath,
        '--builder-id', BUILDER_ID,
      ],
      {
        cwd: ctx.root,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          HOME: home,
          PATH: `${binDir}:${ctx.fakeClaudeBinDir}:${process.env.PATH ?? ''}`,
        },
      },
    );
  }

  /** Seed the intent `lazy upgrade` writes just before it stops a builder. */
  async function seedIntent(): Promise<void> {
    const storage = await daemonStorage();
    await storage.saveBuilderResumeIntent({
      builderId: BUILDER_ID,
      projectRoot: ctx.root,
      createdAt: new Date().toISOString(),
      upgradePid: process.pid,
    } satisfies BuilderResumeIntent);
  }

  async function readIntent(): Promise<BuilderResumeIntent | undefined> {
    const storage = await daemonStorage();
    const intents = await storage.listBuilderResumeIntents(ctx.root);
    return intents.find(i => i.builderId === BUILDER_ID);
  }

  const sessionFile = (sessionId: string): string =>
    join(home, '.claude', 'projects', encodeProjectPath(ctx.root), `${sessionId}.jsonl`);

  const exists = async (p: string): Promise<boolean> =>
    access(p).then(() => true, () => false);

  // INVARIANT: SIGTERM stamps. This is the signal `lazy upgrade` now sends
  // (`docker stop --time`), and the stamp is what the relaunch loop reads back to
  // pass as `--resume`. The stamp used to live after the Claude child exited —
  // a line a signalled supervisor never reaches — so upgrade lost it entirely.
  test('SIGTERM (upgrade stop) stamps the live session onto the resume intent', async () => {
    await ctx.setClaudeScenario({
      steps: [
        { kind: 'session-jsonl', sessionId: 'term-sess', userText: 'hello', assistantText: 'hi' },
        { kind: 'sleep', ms: 60_000 },
      ],
    });
    await seedIntent();
    const proc = await startSupervisor(await writeDaemonConfig());

    await waitFor(() => exists(sessionFile('term-sess')), 45_000, 'the session JSONL to appear');
    proc.kill('SIGTERM');
    await proc.exited;

    const intent = await readIntent();
    expect(intent?.sessionId).toBe('term-sess');
  }, 120_000);

  // INVARIANT: a HARD kill is still resumable. The supervisor gets no chance to
  // stamp anything (this is what `docker kill` did, and what an OOM or a crashed
  // supervisor still does), so the host must work the session id out for itself
  // from the JSONL in the projects dir it mounted. Without this, the relaunch
  // loop's only remaining source was "newest conversation anywhere in this
  // project" — frequently a different session entirely.
  test('SIGKILL stamps nothing, and the host recovers the session id anyway', async () => {
    const launchedAtMs = Date.now();
    await ctx.setClaudeScenario({
      steps: [
        { kind: 'session-jsonl', sessionId: 'kill-sess', userText: 'hello', assistantText: 'hi' },
        { kind: 'sleep', ms: 60_000 },
      ],
    });
    await seedIntent();
    const proc = await startSupervisor(await writeDaemonConfig());

    await waitFor(() => exists(sessionFile('kill-sess')), 45_000, 'the session JSONL to appear');
    proc.kill('SIGKILL');
    await proc.exited;

    // The loss is real — this is why host-side recovery exists, not a nicety.
    expect((await readIntent())?.sessionId).toBeUndefined();

    // What `lazy builder` does after the child exits, however it died.
    const detected = await detectBuilderLaunchSessionId({
      lazyRoot: ctx.root,
      launchedAtMs,
      resumeId: null,
      homeDirAbs: home,
    });
    expect(detected).toBe('kill-sess');
  }, 120_000);
});
