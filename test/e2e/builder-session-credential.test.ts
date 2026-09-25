/**
 * `startBuilderSession` / `endBuilderSession` — credential binding and
 * registry lifecycle, daemon-side (docs/design/actor-identity-and-remote-clients.md §5.2, §5.5).
 *
 * Every assertion here is reachable WITHOUT a real container: the credential
 * check runs before the daemon ever shells out to docker
 * (src/daemon/builder-sessions.ts `launchDetachedContainer`), and the
 * resume-intent → session capture in `endBuilderSession` degrades gracefully
 * when the container is already gone (or never existed) — exactly the shape
 * `lazy upgrade`'s SIGKILL recovery already relies on
 * (test/e2e/builder-kill-resume.test.ts). So this suite talks to the daemon
 * directly over its TCP port, the same template as builder-cap-daemon-side.test.ts,
 * and never launches Docker.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';
import { resetConcurrencyStateForTest } from '../../src/daemon/concurrency';
import { NO_OWNER_CREDENTIAL_MARKER } from '../../src/daemon/turn-credentials';
import { RemoteStorage } from '../../src/storage/remote-storage';
import type { BuilderResumeIntent } from '../../src/storage/types';

const TOKEN = 'test-token-builder-session';
// setupTestLazy() configures this as the project's git identity — see
// test/helpers/setup.ts. Outside managed mode this is who a control-token
// call is attributed to, and therefore the member a builder session it starts
// is registered under.
const GIT_EMAIL = 'test@lazy.test';

isolateInProcessDaemonEnv();

describe('daemon-owned builder session: credential binding and registry', () => {
  let ctx: TestContext;
  let daemon: RunningDaemon | undefined;
  let restoreConfig: (() => void) | undefined;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    ctx = await setupTestLazy();
    restoreConfig = pinConfig(ctx.root);
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);
    resetConcurrencyStateForTest();
    daemon = await startDaemonServer({ token: TOKEN, projectRoot: ctx.root });
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    daemon = undefined;
    resetConcurrencyStateForTest();
    restoreConfig?.();
    restoreConfig = undefined;
    await ctx.cleanup();
    restoreDaemonBaseDir?.();
    restoreDaemonBaseDir = undefined;
    await removeDaemonBaseDir(daemonBaseDir);
  });

  async function rpc(command: string, params: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
    const resp = await fetch(`http://127.0.0.1:${daemon!.webPort}/rpc/${command}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
        'X-Lazy-Project': ctx.root,
      },
      body: JSON.stringify(params),
    });
    return { status: resp.status, body: await resp.json() };
  }

  /** A minimal DaemonClient-shaped object over this test's own fetch helper. */
  function daemonStorage(): RemoteStorage {
    const client = {
      rpc: async (command: string, _projectRoot: string, params: Record<string, unknown>) => {
        const { status, body } = await rpc(command, params);
        if (status >= 400) throw new Error(body?.error ?? `RPC ${command} failed (${status})`);
        return body;
      },
    } as unknown as import('../../src/daemon/client').DaemonClient;
    return new RemoteStorage(client, ctx.root, '');
  }

  // INVARIANT: a member with no stored credential is refused with the wire
  // marker Rails matches on — never silently billed to the project's service
  // credential (§5.5's stated rule: "a builder session is a human asking for
  // something, not automation"). Team mode is turned on here by pushing a
  // credential for a DIFFERENT user; the acting member (the project's git
  // identity) still has none of their own.
  test('a member with no stored credential is refused, not billed to anyone else', async () => {
    await rpc('putUserCredential', { userId: 'someone-else@example.com', kind: 'oauth', token: 'sk-ant-oat01-someone-elses-token' });

    const { status, body } = await rpc('startBuilderSession', {});
    expect(status).toBe(400);
    expect(body.error).toContain(NO_OWNER_CREDENTIAL_MARKER);
    expect(body.error).toContain(GIT_EMAIL);

    // Refused before any row was written — no orphaned 'starting' session left
    // behind by a launch that never got a credential.
    const storage = daemonStorage();
    expect(await storage.listBuilderSessions(ctx.root)).toEqual([]);
  });

  // Outside team mode, `startBuilderSession` must not require a credential at
  // all — the non-managed `lazy builder` path stays exactly as it works today.
  // The launch itself still fails here (no Docker in this test environment),
  // but it must fail at the CONTAINER step, never at the credential check.
  test('outside team mode, no credential is required before the container step', async () => {
    const { status, body } = await rpc('startBuilderSession', {});
    // Never the credential refusal.
    expect(body.error ?? '').not.toContain(NO_OWNER_CREDENTIAL_MARKER);
    // Docker is unavailable in this environment, so the launch fails past the
    // credential gate — proving the gate was cleared rather than skipped.
    expect(status).toBeGreaterThanOrEqual(400);
  });

  // The registry state machine: `endBuilderSession` must degrade gracefully
  // when the container is already gone, and must still capture whatever the
  // resume-intent handshake recorded (the SIGTERM path a real supervisor
  // would have stamped — test/e2e/builder-kill-resume.test.ts proves that half
  // of the handshake against a real supervisor process).
  test('endBuilderSession captures the resume-intent session id even when the container is already gone', async () => {
    const storage = daemonStorage();
    const now = new Date().toISOString();
    await storage.createBuilderSession({
      id: 'sess-fixture-1',
      projectRoot: ctx.root,
      memberEmail: GIT_EMAIL,
      kind: 'interactive',
      state: 'running',
      containerName: 'lazy-builder-d0e5a075',
      builderId: 'd0e5a075',
      agentSessionId: null,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    });
    await storage.saveBuilderResumeIntent({
      builderId: 'd0e5a075',
      projectRoot: ctx.root,
      sessionId: 'claude-sess-abc',
      createdAt: now,
    } satisfies BuilderResumeIntent);

    const { status, body } = await rpc('endBuilderSession', { id: 'sess-fixture-1' });
    expect(status).toBe(200);
    expect(body.state).toBe('ended');
    expect(body.agentSessionId).toBe('claude-sess-abc');
    expect(body.endedAt).toBeTruthy();

    // Ending is terminal: the intent was consumed (not left for a resume that
    // will never come — an ended session is never resumed, §5.7).
    expect(await storage.listBuilderResumeIntents(ctx.root)).toEqual([]);
  });

  test('endBuilderSession is idempotent for an already-ended session', async () => {
    const storage = daemonStorage();
    const now = new Date().toISOString();
    await storage.createBuilderSession({
      id: 'sess-fixture-2',
      projectRoot: ctx.root,
      memberEmail: GIT_EMAIL,
      kind: 'interactive',
      state: 'ended',
      containerName: null,
      builderId: '90e0e0e0',
      agentSessionId: 'sess-already',
      createdAt: now,
      updatedAt: now,
      endedAt: now,
    });

    const { status, body } = await rpc('endBuilderSession', { id: 'sess-fixture-2' });
    expect(status).toBe(200);
    expect(body.state).toBe('ended');
    expect(body.agentSessionId).toBe('sess-already');
  });

  test('endBuilderSession 404s for an unknown session id', async () => {
    const { status } = await rpc('endBuilderSession', { id: 'nope' });
    expect(status).toBe(404);
  });

  // INVARIANT: a 'running' row whose container a daemon restart already reaped
  // must not be trusted at face value — startBuilderSession verifies liveness
  // and falls through to the resume path, capturing whatever the resume-intent
  // handshake stamped, exactly as `endBuilderSession` would have. Without this,
  // a restarted daemon would hand back a session row pointing at a container
  // that no longer exists, forever.
  test('a stale "running" row (container already reaped) is detected and moved to stopped, capturing the resume intent', async () => {
    const storage = daemonStorage();
    const now = new Date().toISOString();
    await storage.createBuilderSession({
      id: 'sess-stale-1',
      projectRoot: ctx.root,
      memberEmail: GIT_EMAIL,
      kind: 'interactive',
      state: 'running',
      containerName: 'lazy-builder-7ea9ed00',
      builderId: '7ea9ed00',
      agentSessionId: null,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    });
    await storage.saveBuilderResumeIntent({
      builderId: '7ea9ed00',
      projectRoot: ctx.root,
      sessionId: 'claude-sess-after-restart',
      createdAt: now,
      reason: 'daemon-restart',
    } satisfies BuilderResumeIntent);

    // The container named on the row was never actually started in this test
    // (no Docker here), so `runner.isRunning` reports it dead — exactly the
    // state a real daemon restart leaves behind, minus the daemon actually
    // having restarted. startBuilderSession must not trust the stale 'running'
    // row: it falls through to the (Docker-less, and therefore failing) resume
    // launch — but only AFTER capturing the resume intent onto the row.
    await rpc('startBuilderSession', {});

    const after = await storage.getBuilderSession('sess-stale-1');
    expect(after?.agentSessionId).toBe('claude-sess-after-restart');
    expect(after?.state).not.toBe('running');
    // The intent is consumed once captured — a second stale detection must not
    // find a phantom session id from a previous restart.
    expect(await storage.listBuilderResumeIntents(ctx.root)).toEqual([]);
  });
});
